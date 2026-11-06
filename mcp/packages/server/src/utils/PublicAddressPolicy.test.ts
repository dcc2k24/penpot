import assert from "node:assert/strict";
import { test } from "node:test";
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
