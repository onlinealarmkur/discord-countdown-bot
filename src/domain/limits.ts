export interface CountdownLimits {
  perGuild: number;
  total: number;
  perUser: number;
  creationsPerMinute: number;
}

// Provisional active-inventory bounds; per-user and creation-rate values are anti-spam policy.
// Validate host resources and delivery latency before treating these as capacity guarantees.
export const DEFAULT_COUNTDOWN_LIMITS: Readonly<CountdownLimits> = Object.freeze({
  perGuild: 5_000,
  total: 10_000,
  perUser: 10,
  creationsPerMinute: 5,
});
