export interface TelemetryInput {
  active_connection_count: number;
  queue_backlog_size: number;
  regional_demand_index: number;
  historical_time_weight: number;
}

/** Mirrors Backend/main.py — guarantees non-zero ms for UI fallback */
export function computePredictedDelayMs(input: TelemetryInput): number {
  const nConns = Math.min(input.active_connection_count / 10000, 1);
  const nBacklog = Math.min(input.queue_backlog_size / 1000, 1);
  const nDemand = input.regional_demand_index / 10;
  const nTime = input.historical_time_weight / 2400;

  const delay =
    8 +
    nConns * 120 +
    nBacklog * 55 +
    nDemand * 18 +
    nTime * 10;

  return Math.round(Math.max(5, delay) * 100) / 100;
}

export function buildNodeSnapshot(
  nodeName: string,
  base: TelemetryInput,
  loadMultiplier: number
): TelemetryInput & { node_name: string } {
  return {
    node_name: nodeName,
    active_connection_count: Math.round(base.active_connection_count * loadMultiplier),
    queue_backlog_size: Math.round(base.queue_backlog_size * loadMultiplier),
    regional_demand_index: Math.min(10, base.regional_demand_index * loadMultiplier),
    historical_time_weight: base.historical_time_weight,
  };
}
