import { test } from "node:test";
import assert from "node:assert/strict";
import { canUseGlobalNotificationChannels, isSafePushEndpoint } from "./notify-safety.ts";

test("push endpoint accepts normal HTTPS push services and public IP literals", () => {
  assert.equal(isSafePushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/abc"), true);
  assert.equal(isSafePushEndpoint("https://fcm.googleapis.com/fcm/send/abc?token=1"), true);
  assert.equal(isSafePushEndpoint("https://8.8.8.8/push"), true);
  assert.equal(isSafePushEndpoint("https://[2606:4700:4700::1111]/push"), true);
});

test("push endpoint rejects non-HTTPS, credentials, fragments and malformed values", () => {
  for (const endpoint of [
    "http://push.example.com/sub",
    "https://user:pass@push.example.com/sub",
    "https://push.example.com/sub#ignored",
    "not a URL",
    "",
  ]) {
    assert.equal(isSafePushEndpoint(endpoint), false, endpoint);
  }
});

test("push endpoint rejects local and private hostnames", () => {
  for (const endpoint of [
    "https://localhost/push",
    "https://worker.localhost/push",
    "https://intranet/push",
    "https://printer.local/push",
    "https://metadata.google.internal/push",
    "https://service.default.svc/push",
    "https://router.home.arpa/push",
  ]) {
    assert.equal(isSafePushEndpoint(endpoint), false, endpoint);
  }
  assert.equal(isSafePushEndpoint("https://localhost.example.com/push"), true);
});

test("push endpoint rejects alternate spellings and special-use IPv4 ranges", () => {
  for (const host of [
    "127.0.0.1",
    "127.1",
    "0x7f000001",
    "2130706433",
    "10.1.2.3",
    "100.64.0.1",
    "169.254.169.254",
    "172.31.255.255",
    "192.168.1.2",
    "192.0.2.1",
    "198.18.0.1",
    "203.0.113.5",
    "224.0.0.1",
    "255.255.255.255",
  ]) {
    assert.equal(isSafePushEndpoint(`https://${host}/push`), false, host);
  }
});

test("push endpoint rejects local, mapped and special-use IPv6 ranges", () => {
  for (const host of [
    "[::]",
    "[::1]",
    "[::ffff:127.0.0.1]",
    "[64:ff9b::a00:1]",
    "[2002:7f00:1::]",
    "[fc00::1]",
    "[fe80::1]",
    "[ff02::1]",
    "[2001:db8::1]",
  ]) {
    assert.equal(isSafePushEndpoint(`https://${host}/push`), false, host);
  }
});

test("deployment-global notification channels are confined to the default tenant", () => {
  assert.equal(canUseGlobalNotificationChannels("default"), true);
  assert.equal(canUseGlobalNotificationChannels("user_123"), false);
  assert.equal(canUseGlobalNotificationChannels(""), false);
});
