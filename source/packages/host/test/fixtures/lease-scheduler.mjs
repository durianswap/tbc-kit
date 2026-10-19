export const TEST_LEASE_SCHEDULER = Object.freeze({
  scheduleLeaseHeartbeat(delayMs, run) {
    const handle = setTimeout(run, delayMs);
    return () => clearTimeout(handle);
  },
});
