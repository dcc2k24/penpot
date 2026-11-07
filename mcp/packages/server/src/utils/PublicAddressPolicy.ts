import { lookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import {
    Agent,
    fetch as fetchWithDispatcher,
    type RequestInit as FetchInit,
    type Response as FetchResponse,
} from "undici";

/** An address that passed the policy, with the family it connects with. */
export interface CheckedAddress {
    /** The address text, IPv4 or IPv6. */
    address: string;
    /** 4 for IPv4 and 6 for IPv6. */
    family: 4 | 6;
}

/**
 * Decides whether a host may be reached by a download that the MCP server makes on behalf of a user.
 *
 * Loopback, private, link-local, unique-local, carrier-grade NAT, benchmarking, multicast, reserved and
 * unspecified addresses are refused, so that a URL cannot make the server call services on its own network.
 * IPv4-mapped IPv6 addresses are judged by their IPv4 part. A download connects to the address that was checked,
 * through {@link pinnedAgent}, so that a second DNS answer cannot move it to a refused address.
 */
export class PublicAddressPolicy {
    /** Address ranges that a download may not reach. */
    private static readonly BLOCKED = PublicAddressPolicy.buildBlockList();

    /**
     * Resolves the host of a URL once, checks every address it resolves to, and returns the first one.
     *
     * @param url - the absolute http or https URL that is about to be fetched
     * @returns the address to connect to
     * @throws Error when the host resolves to no address, or to any refused address
     */
    public static async checkedAddressOf(url: URL): Promise<CheckedAddress> {
        const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
        const literal = isIP(host);
        const addresses: Array<{ address: string; family: number }> =
            literal !== 0 ? [{ address: host, family: literal }] : await lookup(host, { all: true, verbatim: true });
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
        const first = addresses[0];
        return { address: first.address, family: first.family === 6 ? 6 : 4 };
    }

    /**
     * Resolves the host of a URL and checks every address it resolves to.
     *
     * @param url - the absolute http or https URL that is about to be fetched
     * @throws Error when the host resolves to no address, or to any refused address
     */
    public static async assertPublicHost(url: URL): Promise<void> {
        await PublicAddressPolicy.checkedAddressOf(url);
    }

    /**
     * Makes a connection pool whose every connection goes to one checked address.
     *
     * The host name stays in the request, so TLS checks the certificate for it; only the address is fixed.
     *
     * @param checked - the address that the policy accepted
     */
    public static pinnedAgent(checked: CheckedAddress): Agent {
        const lookup: LookupFunction = (_hostname, options, callback) => {
            if (options.all === true) {
                callback(null, [{ address: checked.address, family: checked.family }]);
                return;
            }
            callback(null, checked.address, checked.family);
        };
        return new Agent({ connect: { lookup } });
    }

    /**
     * Fetches a URL over a pinned pool, and hands back the response with the pool that serves it.
     *
     * The caller closes the pool once the response body is read. When the request itself fails, the pool is closed
     * here, so that a failed hop does not leave sockets behind.
     *
     * @param checked - the address that the policy accepted for the URL's host
     * @param url - the URL to fetch
     * @param init - request options, without the dispatcher, which this method sets
     * @returns the response, and the pool that must be closed after the body is read
     * @throws the error of the request when it fails
     */
    public static async fetchPinned(
        checked: CheckedAddress,
        url: URL,
        init: FetchInit
    ): Promise<{ response: FetchResponse; agent: Agent }> {
        const agent = PublicAddressPolicy.pinnedAgent(checked);
        try {
            const response = await fetchWithDispatcher(url, { ...init, dispatcher: agent });
            return { response, agent };
        } catch (error) {
            await agent.close();
            throw error;
        }
    }

    /**
     * Indicates whether an IP address belongs to a range that downloads may reach.
     *
     * @param address - IPv4 or IPv6 address text
     * @returns false for a refused range, such as loopback, private, link-local or multicast
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
            ["192.0.0.0", 24],
            ["192.168.0.0", 16],
            ["198.18.0.0", 15],
            ["224.0.0.0", 4],
            ["240.0.0.0", 4],
        ];
        for (const [address, prefix] of ipv4) {
            list.addSubnet(address, prefix, "ipv4");
        }
        const ipv6: [string, number][] = [
            ["::", 128],
            ["::1", 128],
            ["64:ff9b::", 96],
            ["2002::", 16],
            ["fc00::", 7],
            ["fe80::", 10],
            ["ff00::", 8],
        ];
        for (const [address, prefix] of ipv6) {
            list.addSubnet(address, prefix, "ipv6");
        }
        return list;
    }
}
