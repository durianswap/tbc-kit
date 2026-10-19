function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createMemoryWebViewSessionStore() {
  const sessions = new Map();
  const inbound = new Map();
  const deliveries = new Map();
  let ordinal = 0;

  function active(sessionId, navigationId) {
    const session = sessions.get(sessionId);
    return session !== undefined && !session.closed &&
      session.navigation.navigationId === navigationId;
  }

  const store = {
    async openSession(navigation) {
      const existing = sessions.get(navigation.sessionId);
      if (existing !== undefined) {
        if (existing.closed || !same(existing.navigation, navigation)) {
          throw new Error("session collision");
        }
        return;
      }
      sessions.set(navigation.sessionId, { navigation: structuredClone(navigation), closed: false });
    },
    async closeSession(input) {
      const session = sessions.get(input.sessionId);
      if (session === undefined || session.navigation.navigationId !== input.navigationId) return;
      session.closed = true;
      session.reason = input.reason;
    },
    async acceptInbound(input) {
      if (!active(input.sessionId, input.navigationId)) return "collision";
      const key = `${input.sessionId}:${input.messageId}`;
      const existing = inbound.get(key);
      if (existing !== undefined) return same(existing, input) ? "replay" : "collision";
      inbound.set(key, structuredClone(input));
      return "accepted";
    },
    async enqueueDelivery(input) {
      if (!active(input.sessionId, input.navigationId)) return "collision";
      const key = `${input.sessionId}:${input.deliveryId}`;
      const existing = deliveries.get(key);
      if (existing !== undefined) {
        const { state: _state, ordinal: _ordinal, ...comparable } = existing;
        return same(comparable, input) ? "replay" : "collision";
      }
      ordinal += 1;
      deliveries.set(key, { ...structuredClone(input), state: "pending", ordinal });
      return "accepted";
    },
    async markDeliverySent(input) {
      const record = deliveries.get(`${input.sessionId}:${input.deliveryId}`);
      if (record === undefined || record.envelopeDigest !== input.envelopeDigest) return "collision";
      if (record.state === "pending") {
        record.state = "sent";
        return "accepted";
      }
      return "replay";
    },
    async acknowledgeDelivery(input) {
      const record = deliveries.get(`${input.sessionId}:${input.deliveryId}`);
      if (
        record === undefined ||
        record.envelopeDigest !== input.envelopeDigest ||
        record.state === "pending"
      ) return "collision";
      if (record.state === "acknowledged") return "replay";
      record.state = "acknowledged";
      return "accepted";
    },
    async listOutstanding(sessionId) {
      return [...deliveries.values()]
        .filter((record) => record.sessionId === sessionId && record.state !== "acknowledged")
        .sort((left, right) => left.ordinal - right.ordinal)
        .map(({ ordinal: _ordinal, ...record }) => structuredClone(record));
    },
  };

  return { store, sessions, inbound, deliveries };
}

