import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applicationServerKeyMatches,
  disablePush,
  enablePush,
} from "./notify-client.ts";

const VAPID_KEY = "AQIDBA"; // URL-safe base64 for [1, 2, 3, 4].

interface MockSubscriptionOptions {
  endpoint?: string;
  key?: Uint8Array;
  unsubscribe?: () => Promise<boolean>;
}

function mockSubscription(options: MockSubscriptionOptions = {}): PushSubscription {
  const endpoint = options.endpoint ?? "https://push.example.test/subscription";
  const key = options.key ?? new Uint8Array([1, 2, 3, 4]);
  return {
    endpoint,
    expirationTime: null,
    options: { applicationServerKey: key.buffer, userVisibleOnly: true },
    getKey: () => null,
    toJSON: () => ({
      endpoint,
      keys: { p256dh: "key", auth: "auth" },
    }),
    unsubscribe: options.unsubscribe ?? (async () => true),
  } as unknown as PushSubscription;
}

interface PushEnvironmentOptions {
  existing: PushSubscription | null;
  created?: PushSubscription;
  fetchResponse?: () => Promise<Response>;
}

async function withPushEnvironment<T>(
  options: PushEnvironmentOptions,
  run: (calls: { subscribe: number; fetch: RequestInit[] }) => Promise<T>,
): Promise<T> {
  const names = ["window", "navigator", "Notification", "fetch"] as const;
  const descriptors = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const calls = { subscribe: 0, fetch: [] as RequestInit[] };
  const created = options.created ?? mockSubscription();
  const registration = {
    pushManager: {
      getSubscription: async () => options.existing,
      subscribe: async () => {
        calls.subscribe += 1;
        return created;
      },
    },
  } as unknown as ServiceWorkerRegistration;
  const notification = {
    permission: "granted",
    requestPermission: async () => "granted" as NotificationPermission,
  };

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { PushManager: function PushManager() {}, Notification: notification },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {
      serviceWorker: {
        getRegistration: async () => registration,
        register: async () => registration,
        ready: Promise.resolve(registration),
      },
    },
  });
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    writable: true,
    value: notification,
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async (_input: string | URL | Request, init?: RequestInit) => {
      calls.fetch.push(init ?? {});
      return options.fetchResponse?.() ?? new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  try {
    return await run(calls);
  } finally {
    for (const name of names) {
      const descriptor = descriptors.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
}

test("applicationServerKeyMatches compares ArrayBuffer and typed-array keys", () => {
  assert.equal(applicationServerKeyMatches(new Uint8Array([1, 2, 3, 4]).buffer, VAPID_KEY), true);
  assert.equal(applicationServerKeyMatches(new Uint8Array([1, 2, 3, 4]), VAPID_KEY), true);
  assert.equal(applicationServerKeyMatches(new Uint8Array([1, 2, 3, 5]), VAPID_KEY), false);
  assert.equal(applicationServerKeyMatches(new Uint8Array([1, 2, 3]), VAPID_KEY), false);
  assert.equal(applicationServerKeyMatches(null, VAPID_KEY), false);
});

test("failed server registration rolls back a newly created browser subscription", async () => {
  let unsubscribeCalls = 0;
  const created = mockSubscription({
    unsubscribe: async () => {
      unsubscribeCalls += 1;
      return true;
    },
  });
  await withPushEnvironment(
    {
      existing: null,
      created,
      fetchResponse: async () => new Response(JSON.stringify({ error: "Server refused registration" }), { status: 500 }),
    },
    async (calls) => {
      const result = await enablePush(VAPID_KEY);
      assert.deepEqual(result, { ok: false, reason: "error", message: "Server refused registration" });
      assert.equal(calls.subscribe, 1);
      assert.equal(unsubscribeCalls, 1);
    },
  );
});

test("a matching existing subscription is reused without rollback", async () => {
  let unsubscribeCalls = 0;
  const existing = mockSubscription({
    unsubscribe: async () => {
      unsubscribeCalls += 1;
      return true;
    },
  });
  await withPushEnvironment(
    {
      existing,
      fetchResponse: async () => new Response(JSON.stringify({ error: "Server unavailable" }), { status: 503 }),
    },
    async (calls) => {
      const result = await enablePush(VAPID_KEY);
      assert.equal(result.ok, false);
      assert.equal(calls.subscribe, 0);
      assert.equal(unsubscribeCalls, 0);
    },
  );
});

test("an outdated VAPID subscription is removed and replaced", async () => {
  let oldUnsubscribeCalls = 0;
  const existing = mockSubscription({
    endpoint: "https://push.example.test/outdated",
    key: new Uint8Array([9, 9, 9, 9]),
    unsubscribe: async () => {
      oldUnsubscribeCalls += 1;
      return true;
    },
  });
  await withPushEnvironment({ existing }, async (calls) => {
    const result = await enablePush(VAPID_KEY);
    assert.deepEqual(result, { ok: true });
    assert.equal(oldUnsubscribeCalls, 1);
    assert.equal(calls.subscribe, 1);
    assert.equal(calls.fetch.length, 2);
    assert.equal(calls.fetch[0]?.method, "DELETE");
    assert.equal(calls.fetch[1]?.method, "POST");
  });
});

test("disable keeps the browser subscription when server removal fails", async () => {
  let unsubscribeCalls = 0;
  const existing = mockSubscription({
    unsubscribe: async () => {
      unsubscribeCalls += 1;
      return true;
    },
  });
  await withPushEnvironment(
    {
      existing,
      fetchResponse: async () => new Response(JSON.stringify({ error: "Server removal failed" }), { status: 500 }),
    },
    async () => {
      await assert.rejects(disablePush(), /Server removal failed/);
      assert.equal(unsubscribeCalls, 0);
    },
  );
});

test("disable verifies browser unsubscription and surfaces a false result", async () => {
  const existing = mockSubscription({ unsubscribe: async () => false });
  await withPushEnvironment({ existing }, async (calls) => {
    await assert.rejects(disablePush(), /couldn't disable/i);
    assert.equal(calls.fetch[0]?.method, "DELETE");
  });
});

test("disable succeeds only after server and browser removal succeed", async () => {
  let unsubscribeCalls = 0;
  const existing = mockSubscription({
    unsubscribe: async () => {
      unsubscribeCalls += 1;
      return true;
    },
  });
  await withPushEnvironment({ existing }, async (calls) => {
    await disablePush();
    assert.equal(calls.fetch[0]?.method, "DELETE");
    assert.equal(unsubscribeCalls, 1);
  });
});
