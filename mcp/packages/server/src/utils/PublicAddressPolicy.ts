import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * Decides whether a host may be reached by a download that the MCP server makes on behalf of a user.
 *
 * Loopback, private, link-local, unique-local, carrier-grade NAT and unspecified addresses are refused, so
 * that a URL cannot make the server call services on its own network. IPv4-mapped IPv6 addresses are judged
 * by their IPv4 part.
 */
export class PublicAddressPolicy {
    /** Address ranges that a download may not reach. */
    private static readonly BLOCKED = PublicAddressPolicy.buildBlockList();

    /**
     * Resolves the host of a URL and checks every address it resolves to.
     *
     * @param url - the absolute http or https URL that is about to be fetched
     * @throws Error when the host resolves to no address, or to any refused address
     */
    public static async assertPublicHost(url: URL): Promise<void> {
        const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
        const addresses = isIP(host) !== 0 ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
        if (addresses.length === 0) {
            throw new Error("The url host has no address.");
        }
        for (const { address } of addresses) {
            if (!PublicAddressPolicy.isPublic(address)) {
                throw new Error(
                    "The url points to a private, loopback or link-local address, which the server refuses to fetch."
                );
            }
        }
    }

    /**
     * Indicates whether an IP address belongs to a range that downloads may reach.
     *
     * @param address - IPv4 or IPv6 address text
     * @returns false for loopback, private, link-local, unique-local, CGNAT and unspecified addresses
     */
    public static isPublic(address: string): boolean {
        const normalized = address.toLowerCase();
        const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized);
        const candidate = mapped?.[1] ?? normalized;
        const family = isIP(candidate);
        if (family === 0) {
            return false;
        }
        return !PublicAddressPolicy.BLOCKED.check(candidate, family === 4 ? "ipv4" : "ipv6");
    }

    /**
     * Builds the block list of the refused ranges.
     */
    private static buildBlockList(): BlockList {
        const list = new BlockList();
        const ipv4: [string, number][] = [
            ["0.0.0.0", 8],
            ["10.0.0.0", 8],
            ["100.64.0.0", 10],
            ["127.0.0.0", 8],
            ["169.254.0.0", 16],
            ["172.16.0.0", 12],
            ["192.168.0.0", 16],
        ];
        for (const [address, prefix] of ipv4) {
            list.addSubnet(address, prefix, "ipv4");
        }
        const ipv6: [string, number][] = [
            ["::", 128],
            ["::1", 128],
            ["fc00::", 7],
            ["fe80::", 10],
        ];
        for (const [address, prefix] of ipv6) {
            list.addSubnet(address, prefix, "ipv6");
        }
        return list;
    }
}
