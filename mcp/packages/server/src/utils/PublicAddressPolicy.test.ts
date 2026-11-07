import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { type Agent, fetch } from "undici";
import { PublicAddressPolicy } from "./PublicAddressPolicy";

test("public addresses are allowed", () => {
    for (const address of ["8.8.8.8", "172.32.0.1", "100.63.255.255", "2606:4700::1111", "::ffff:8.8.8.8"]) {
        assert.equal(PublicAddressPolicy.isPublic(address), true, address);
    }
});

test("loopback, private, link-local, unique-local, CGNAT and unspecified addresses are refused", () => {
    for (const address of [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.1",
        "169.254.10.10",
        "100.64.0.1",
        "0.0.0.0",
        "::1",
        "::",
        "fe80::1",
        "fc00::1",
        "fd12:3456::1",
        "::ffff:127.0.0.1",
        "::ffff:10.0.0.1",
    ]) {
        assert.equal(PublicAddressPolicy.isPublic(address), false, address);
    }
});

test("text that is not an IP address is refused", () => {
    assert.equal(PublicAddressPolicy.isPublic("not-an-ip"), false);
});

test("a URL whose host is a loopback address is refused without a DNS lookup", async () => {
    await assert.rejects(
        PublicAddressPolicy.assertPublicHost(new URL("http://127.0.0.1:8080/archive.penpot")),
        /private, loopback or link-local address/
    );
    await assert.rejects(
        PublicAddressPolicy.assertPublicHost(new URL("http://[::1]/archive.penpot")),
        /private, loopback or link-local address/
    );
});

test("a host name that resolves to loopback is refused", async () => {
    await assert.rejects(
        PublicAddressPolicy.assertPublicHost(new URL("http://localhost/archive.penpot")),
        /private, loopback or link-local address/
    );
});

test("the ranges that were missing are refused: NAT64, 6to4, benchmarking, IETF protocol, multicast and reserved", () => {
    for (const address of [
        "64:ff9b::808:808",
        "2002:c000:201::1",
        "198.18.0.1",
        "198.19.255.255",
        "192.0.0.8",
        "224.0.0.1",
        "239.255.255.255",
        "240.0.0.1",
        "ff02::1",
    ]) {
        assert.equal(PublicAddressPolicy.isPublic(address), false, address);
    }
});

test("a checked address is the address the policy accepted, so that a connection can be pinned to it", async () => {
    assert.deepEqual(await PublicAddressPolicy.checkedAddressOf(new URL("https://8.8.8.8/archive.penpot")), {
        address: "8.8.8.8",
        family: 4,
    });
    assert.deepEqual(await PublicAddressPolicy.checkedAddressOf(new URL("https://[2606:4700::1111]/x")), {
        address: "2606:4700::1111",
        family: 6,
    });
});

test("a checked address of a refused literal is refused, with the same message", async () => {
    await assert.rejects(
        PublicAddressPolicy.checkedAddressOf(new URL("http://224.0.0.1/archive.penpot")),
        /private, loopback or link-local address/
    );
});

test("a pinned fetch that fails closes its pool, so the failed hop leaves no sockets behind", async () => {
    // a port that nothing listens on: the connection is refused at once
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    let pool: Agent | undefined;
    const original = PublicAddressPolicy.pinnedAgent;
    PublicAddressPolicy.pinnedAgent = (checked) => {
        pool = original(checked);
        return pool;
    };
    try {
        await assert.rejects(
            PublicAddressPolicy.fetchPinned(
                { address: "127.0.0.1", family: 4 },
                new URL(`http://pinned.invalid:${port}/archive.penpot`),
                { redirect: "manual" }
            )
        );
        // the runtime flag is not in the undici typings
        assert.equal((pool as unknown as { closed: boolean } | undefined)?.closed, true);
    } finally {
        PublicAddressPolicy.pinnedAgent = original;
    }
});

test("a pinned agent connects to the checked address, whatever the host name would resolve to", async () => {
    const server = http.createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("pinned");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    // the name ends in .invalid, so it cannot resolve; only the pinned address can answer
    const agent = PublicAddressPolicy.pinnedAgent({ address: "127.0.0.1", family: 4 });
    try {
        const response = await fetch(`http://pinned.invalid:${port}/archive.penpot`, { dispatcher: agent });
        assert.equal(await response.text(), "pinned");
    } finally {
        await agent.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
