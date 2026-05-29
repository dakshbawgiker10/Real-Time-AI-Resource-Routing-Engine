"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Activity,
  Server,
  Network,
  Terminal,
  Settings2,
  Zap,
  Cpu,
  HardDrive,
  Wifi,
  ToggleLeft,
  ToggleRight,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ArrowRightLeft,
  Radio,
  Brain,
  Gauge,
} from "lucide-react";
import { supabase } from "../supabase";
import {
  buildNodeSnapshot,
  computePredictedDelayMs,
  type TelemetryInput,
} from "../lib/inference";

const API_PORTS = [8001, 8000];
const ROUTE_POLL_MS = 3000;

interface SystemNode {
  id: string;
  node_name: string;
  status: string;
  current_load_percentage: number;
}

interface TelemetryLog {
  id: string;
  timestamp: string;
  message: string;
  type: "system" | "prediction" | "alert" | "metric" | "routing";
  metadata?: Record<string, unknown>;
}

interface NodePrediction {
  node_name: string;
  predicted_delay_ms: number;
}

const NODE_LOAD_FACTORS: Record<string, number> = {
  "US-East-Alpha": 1.0,
  "EU-West-Core": 0.72,
  "AP-South-Opt": 1.18,
};

export default function Dashboard() {
  const [mounted, setMounted] = useState(false);
  const [apiBase, setApiBase] = useState<string | null>(null);
  const [apiOnline, setApiOnline] = useState(false);
  const [realtimeOk, setRealtimeOk] = useState(false);

  const lastLogIdRef = useRef<number | null>(null);
  const predictTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [nodes, setNodes] = useState<SystemNode[]>([
    { id: "n1", node_name: "US-East-Alpha", status: "active", current_load_percentage: 45 },
    { id: "n2", node_name: "EU-West-Core", status: "healthy", current_load_percentage: 12 },
    { id: "n3", node_name: "AP-South-Opt", status: "critical", current_load_percentage: 88 },
  ]);
  const [logs, setLogs] = useState<TelemetryLog[]>([]);
  const [isManualMode, setIsManualMode] = useState(false);
  const [optimalNode, setOptimalNode] = useState("Calculating...");
  const [prevOptimalNode, setPrevOptimalNode] = useState<string | null>(null);
  const [routeFlash, setRouteFlash] = useState(false);
  const [lowestDelayMs, setLowestDelayMs] = useState<number | null>(null);
  const [nodePredictions, setNodePredictions] = useState<NodePrediction[]>([]);
  const [liveDelayMs, setLiveDelayMs] = useState(0);

  const [simulator, setSimulator] = useState<TelemetryInput>({
    active_connection_count: 1500,
    queue_backlog_size: 45,
    regional_demand_index: 3.5,
    historical_time_weight: 1200,
  });

  const [serverSimulators, setServerSimulators] = useState<Record<string, TelemetryInput>>({});
  const serverSimulatorsRef = useRef<Record<string, TelemetryInput>>({});
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  const addLog = useCallback(
    (message: string, type: TelemetryLog["type"] = "system", metadata?: Record<string, unknown>) => {
      setLogs((prev) =>
        [
          ...prev,
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            timestamp: new Date().toISOString(),
            message,
            type,
            metadata,
          },
        ].slice(-60)
      );
    },
    []
  );

  const resolveApiBase = useCallback(async (): Promise<string | null> => {
    for (const port of API_PORTS) {
      try {
        const base = `http://127.0.0.1:${port}`;
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) continue;
        const data = await res.json();
        if (data.version === "5.0.0" || data.engine) {
          return base;
        }
      } catch {
        /* try next port */
      }
    }
    for (const port of API_PORTS) {
      try {
        const base = `http://127.0.0.1:${port}`;
        const res = await fetch(`${base}/predict-delay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(simulator),
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
          const data = await res.json();
          if (Number(data.predicted_delay_ms) > 0) return base;
        }
      } catch {
        /* try next */
      }
    }
    return null;
  }, [simulator]);

  const fetchPredictedDelay = useCallback(
    async (input: TelemetryInput, base: string | null): Promise<number> => {
      const fallback = computePredictedDelayMs(input);
      if (!base) return fallback;
      try {
        const res = await fetch(`${base}/predict-delay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        if (res.ok) {
          const data = await res.json();
          const delay = Number(data.predicted_delay_ms);
          if (delay > 0) return delay;
        }
      } catch {
        /* use fallback */
      }
      return fallback;
    },
    []
  );

  const pushRoutingDecision = useCallback(
    async (input: TelemetryInput, base: string | null) => {
      const snapshots = nodes.map((node) => {
        if (serverSimulatorsRef.current[node.node_name]) {
          return { ...serverSimulatorsRef.current[node.node_name], node_name: node.node_name };
        }
        const factor = NODE_LOAD_FACTORS[node.node_name] ?? 1;
        return buildNodeSnapshot(node.node_name, input, factor);
      });

      const localPredictions = snapshots.map((s) => ({
        node_name: s.node_name,
        predicted_delay_ms: computePredictedDelayMs(s),
      }));

      if (!base) {
        const best = localPredictions.reduce((a, b) =>
          a.predicted_delay_ms < b.predicted_delay_ms ? a : b
        );
        setNodePredictions(localPredictions);
        setLowestDelayMs(best.predicted_delay_ms);
        setOptimalNode((prev) => {
          if (prev !== best.node_name && prev !== "Calculating...") {
            setPrevOptimalNode(prev);
            setRouteFlash(true);
            setTimeout(() => setRouteFlash(false), 2200);
          }
          return best.node_name;
        });
        return;
      }

      try {
        const res = await fetch(`${base}/update-routing-decision`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cluster_snapshot: snapshots }),
        });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.all_predictions)) {
            setNodePredictions(data.all_predictions);
          }
          if (typeof data.lowest_predicted_delay_ms === "number") {
            setLowestDelayMs(data.lowest_predicted_delay_ms);
          }
          const target = data.optimal_node as string;
          if (target) {
            setOptimalNode((prev) => {
              if (prev !== target && prev !== "Calculating...") {
                setPrevOptimalNode(prev);
                setRouteFlash(true);
                setTimeout(() => setRouteFlash(false), 2200);
                addLog(`Rerouting: ${prev} → ${target}`, "routing");
              }
              return target;
            });
          }
        }
      } catch {
        setNodePredictions(localPredictions);
      }
    },
    [nodes, addLog]
  );

  const runInference = useCallback(
    async (input: TelemetryInput) => {
      const delay = await fetchPredictedDelay(input, apiBase);
      setLiveDelayMs(delay);
      addLog(`Inference complete — predicted latency ${delay.toFixed(2)} ms`, "prediction");
      if (isManualMode) {
        await pushRoutingDecision(input, apiBase);
      }
    },
    [apiBase, fetchPredictedDelay, isManualMode, pushRoutingDecision, addLog]
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    (async () => {
      const base = await resolveApiBase();
      setApiBase(base);
      setApiOnline(!!base);
      if (base) {
        addLog(`Inference API connected (${base})`, "system");
        const delay = await fetchPredictedDelay(simulator, base);
        setLiveDelayMs(delay);
      } else {
        addLog("API offline — using client-side inference engine", "alert");
        setLiveDelayMs(computePredictedDelayMs(simulator));
      }
    })();
  }, [mounted, resolveApiBase, fetchPredictedDelay, addLog]);

  useEffect(() => {
    if (!mounted || isManualMode) return;
    const poll = async () => {
      const { data } = await supabase.from("system_nodes").select("*");
      if (data) setNodes(data as SystemNode[]);
    };
    poll();
    const id = setInterval(poll, 2500);
    return () => clearInterval(id);
  }, [mounted, isManualMode]);

  useEffect(() => {
    if (!mounted || !apiBase) return;
    const pollRoute = async () => {
      try {
        const res = await fetch(`${apiBase}/get-optimal-route`);
        if (!res.ok) return;
        const data = await res.json();
        const target = data.optimal_node;
        if (!target || target === "Detecting...") return;

        if (typeof data.lowest_predicted_delay_ms === "number") {
          setLowestDelayMs(data.lowest_predicted_delay_ms);
        }
        if (Array.isArray(data.all_predictions)) {
          setNodePredictions(data.all_predictions);
        }

        setOptimalNode((prev) => {
          if (prev !== target && prev !== "Calculating...") {
            setPrevOptimalNode(prev);
            setRouteFlash(true);
            setTimeout(() => setRouteFlash(false), 2200);
            addLog(`Autonomous reroute: ${prev} → ${target}`, "routing");
          }
          return target;
        });
      } catch {
        /* silent */
      }
    };
    pollRoute();
    const id = setInterval(pollRoute, ROUTE_POLL_MS);
    return () => clearInterval(id);
  }, [mounted, apiBase, addLog]);

  useEffect(() => {
    addLog("Connecting Supabase Realtime…", "system");
    const channel = supabase
      .channel("live-telemetry")
      .on("postgres_changes", { event: "*", schema: "public", table: "system_nodes" }, (payload) => {
        const updated = payload.new as SystemNode;
        setNodes((cur) => {
          const exists = cur.find((n) => n.id === updated.id);
          if (exists) return cur.map((n) => (n.id === updated.id ? updated : n));
          return [...cur, updated];
        });
      })
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "metrics_history_log" },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          const delay = Number(row.actual_processing_delay_ms);
          const displayDelay = delay > 0 ? delay.toFixed(2) : computePredictedDelayMs({
            active_connection_count: Number(row.active_connection_count ?? 0),
            queue_backlog_size: Number(row.queue_backlog_size ?? 0),
            regional_demand_index: Number(row.regional_demand_index ?? 0),
            historical_time_weight: Number(row.historical_time_weight ?? 0),
          }).toFixed(2);
          addLog(
            `Telemetry [${row.node_id}]: ${row.active_connection_count} conns · ${displayDelay} ms`,
            "metric",
            row
          );
        }
      )
      .subscribe((status) => {
        setRealtimeOk(status === "SUBSCRIBED");
        if (status === "SUBSCRIBED") addLog("Realtime stream active", "system");
      });
    return () => {
      supabase.removeChannel(channel);
    };
  }, [addLog]);

  useEffect(() => {
    if (isManualMode && mounted) {
      runInference(simulator);
    }
  }, [isManualMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>, key: keyof TelemetryInput) => {
    const val = parseFloat(e.target.value);
    const next = { ...simulator, [key]: val };
    setSimulator(next);
    
    // Reset specific overrides when global changes
    setServerSimulators({});
    serverSimulatorsRef.current = {};

    if (isManualMode) {
      setNodes((prev) =>
        prev.map((n) => {
          const factor = NODE_LOAD_FACTORS[n.node_name] ?? 1;
          const load = Math.min(100, (next.active_connection_count * factor) / 100);
          let status = "healthy";
          if (load > 75) status = "critical";
          else if (load > 40) status = "degraded";
          return { ...n, current_load_percentage: load, status };
        })
      );
    }

    if (predictTimerRef.current) clearTimeout(predictTimerRef.current);
    predictTimerRef.current = setTimeout(() => runInference(next), 280);
  };

  const handleServerSliderChange = (e: React.ChangeEvent<HTMLInputElement>, nodeName: string, key: keyof TelemetryInput) => {
    e.stopPropagation(); // prevent drag causing weird bubblings
    const val = parseFloat(e.target.value);
    
    let current = serverSimulators[nodeName];
    if (!current) {
       const factor = NODE_LOAD_FACTORS[nodeName] ?? 1;
       current = buildNodeSnapshot(nodeName, simulator, factor);
    }
    const nextSim = { ...current, [key]: val };
    
    setServerSimulators(prev => {
       const nextState = { ...prev, [nodeName]: nextSim };
       serverSimulatorsRef.current = nextState;
       return nextState;
    });

    if (isManualMode) {
      setNodes((prev) =>
        prev.map((n) => {
          if (n.node_name === nodeName) {
             const load = Math.min(100, (nextSim.active_connection_count) / 100);
             let status = "healthy";
             if (load > 75) status = "critical";
             else if (load > 40) status = "degraded";
             return { ...n, current_load_percentage: load, status };
          }
          return n;
        })
      );
    }

    if (predictTimerRef.current) clearTimeout(predictTimerRef.current);
    predictTimerRef.current = setTimeout(() => runInference(simulator), 280);
  };

  const isRouteReady =
    optimalNode !== "Calculating..." && optimalNode !== "Unknown" && optimalNode !== "Detecting...";

  const getNodePosition = (index: number, total: number) => {
    const angle = (index * (360 / Math.max(1, total))) * (Math.PI / 180);
    return {
      lineEndX: 50 + Math.cos(angle) * 38,
      lineEndY: 50 + Math.sin(angle) * 38,
      cardX: Math.cos(angle) * 128,
      cardY: Math.sin(angle) * 128,
    };
  };

  const getStatusIcon = (status: string) => {
    if (status === "healthy" || status === "idle")
      return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
    if (status === "degraded" || status === "active")
      return <Activity className="w-4 h-4 text-sky-400 animate-pulse" />;
    if (status === "critical" || status === "overloaded")
      return <AlertTriangle className="w-4 h-4 text-amber-400" />;
    return <XCircle className="w-4 h-4 text-slate-500" />;
  };

  if (!mounted) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4">
        <div className="w-14 h-14 rounded-2xl glass-panel flex items-center justify-center">
          <Brain className="w-7 h-7 text-indigo-400 animate-pulse" />
        </div>
        <p className="text-sm text-slate-400 font-mono tracking-widest">INITIALIZING ENGINE</p>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col p-4 lg:p-6 gap-5 bg-slate-950 overflow-hidden">
      {/* Header and Explanation */}
      <header className="glass-panel rounded-2xl flex flex-col gap-4 overflow-hidden shrink-0">
        <div className="px-5 py-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-800/50">
          <div className="flex items-center gap-4">
            <div className="w-11 h-11 rounded-xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center shadow-[0_0_24px_rgba(99,102,241,0.25)]">
              <Network className="w-6 h-6 text-indigo-300" />
            </div>
            <div>
              <h1 className="text-lg lg:text-xl font-semibold tracking-tight text-white">
                AI Resource Routing Engine
              </h1>
              <p className="text-xs text-slate-400 mt-0.5">
                Real-time autonomous load balancing system
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`text-[10px] uppercase tracking-wider px-2.5 py-1 rounded-full border font-medium ${
                apiOnline
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                  : "bg-rose-500/10 border-rose-500/30 text-rose-300"
              }`}
            >
              {apiOnline ? "API Online" : "API Offline"}
            </span>
            <span
              className={`text-[10px] uppercase tracking-wider px-2.5 py-1 rounded-full border font-medium ${
                realtimeOk
                  ? "bg-sky-500/10 border-sky-500/30 text-sky-300"
                  : "bg-slate-500/10 border-slate-600 text-slate-400"
              }`}
            >
              {realtimeOk ? "Realtime Stream" : "Database Polling"}
            </span>
            <button
              type="button"
              onClick={() => setIsManualMode((m) => !m)}
              className="flex items-center gap-2 text-xs px-3 py-1.5 rounded-full border border-slate-700 bg-slate-800/60 hover:bg-slate-800 transition-colors"
            >
              <Settings2 className="w-3.5 h-3.5 text-slate-400" />
              <span className="text-slate-300">{isManualMode ? "Manual Simulation" : "Live Auto"}</span>
              {isManualMode ? (
                <ToggleRight className="w-5 h-5 text-indigo-400" />
              ) : (
                <ToggleLeft className="w-5 h-5 text-slate-500" />
              )}
            </button>
          </div>
        </div>
        <div className="px-5 py-3 bg-indigo-500/5 text-sm text-slate-300">
          <strong className="text-indigo-300">How it works:</strong> An AI model continuously predicts request execution times across regions based on server queue sizes, active connections, and historical trends. The load balancer (Ingress) automatically directs new incoming traffic out to the fastest, healthiest node predicted. Traffic is actively distributed and visualized below.
        </div>
      </header>

      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
        <div className="glass-panel rounded-xl p-4 col-span-2 lg:col-span-1">
          <div className="flex items-center gap-2 text-slate-400 text-[10px] uppercase tracking-wider mb-2">
            <Brain className="w-3.5 h-3.5" /> AI Predicted Latency
          </div>
          <p className="text-3xl font-bold font-mono text-emerald-400 tabular-nums">
            {liveDelayMs.toFixed(2)}
            <span className="text-sm text-slate-500 ml-1 font-normal">ms</span>
          </p>
        </div>
        <div className="glass-panel rounded-xl p-4">
          <div className="flex items-center gap-2 text-slate-400 text-[10px] uppercase tracking-wider mb-2">
            <ArrowRightLeft className="w-3.5 h-3.5" /> Primary Route Segment
          </div>
          <p className="text-xl font-semibold text-blue-300 truncate">
            {isRouteReady ? optimalNode : "—"}
          </p>
        </div>
        <div className="glass-panel rounded-xl p-4">
          <div className="flex items-center gap-2 text-slate-400 text-[10px] uppercase tracking-wider mb-2">
            <Gauge className="w-3.5 h-3.5" /> Best Route Latency
          </div>
          <p className="text-xl font-mono text-cyan-300">
            {lowestDelayMs != null ? `${lowestDelayMs.toFixed(2)} ms` : "—"}
          </p>
        </div>
        <div className="glass-panel rounded-xl p-4">
          <div className="flex items-center gap-2 text-slate-400 text-[10px] uppercase tracking-wider mb-2">
            <Radio className="w-3.5 h-3.5" /> Active Server Nodes
          </div>
          <p className="text-xl font-mono text-slate-200">{nodes.length} online</p>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 flex-1 min-h-0 overflow-hidden">
        {/* Controls - scrollable */}
        <section className="lg:col-span-3 flex flex-col gap-4 overflow-y-auto">
          <div className="glass-panel rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-slate-200 mb-2 flex items-center gap-2">
              <Settings2 className="w-4 h-4 text-indigo-400" />
              Traffic Simulator Controls
            </h2>
            <p className="text-[11px] text-slate-400 mb-5 leading-relaxed">
              Use these sliders to simulate different network conditions when in <strong className="text-indigo-400">Manual</strong> mode.
            </p>
            <div className="space-y-6">
              {(
                [
                  { key: "active_connection_count" as const, label: "Total Ingress Connections", icon: Wifi, max: 10000, step: 50, color: "text-indigo-300" },
                  { key: "queue_backlog_size" as const, label: "Network Queue Backlog", icon: HardDrive, max: 1000, step: 10, color: "text-emerald-300" },
                  { key: "regional_demand_index" as const, label: "Demand Index", icon: Activity, max: 10, step: 0.1, color: "text-amber-300" },
                  { key: "historical_time_weight" as const, label: "Time of Day Load", icon: Cpu, max: 2400, step: 50, color: "text-rose-300" },
                ] as const
              ).map(({ key, label, icon: Icon, max, step, color }) => (
                <div key={key} className="space-y-2 pb-2 border-b border-white/5 last:border-0">
                  <div className="flex justify-between text-xs items-center">
                    <span className="text-slate-300 flex items-center gap-1.5 font-medium">
                      <Icon className="w-4 h-4" /> {label}
                    </span>
                    <span className={`font-mono font-bold bg-black/40 px-2 py-0.5 rounded ${color}`}>
                      {key === "regional_demand_index"
                        ? simulator[key].toFixed(1)
                        : simulator[key].toLocaleString()}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={max}
                    step={step}
                    value={simulator[key]}
                    disabled={!isManualMode}
                    onChange={(e) => handleSliderChange(e, key)}
                    className="w-full mt-2"
                  />
                </div>
              ))}
            </div>
            {!isManualMode && (
              <p className="mt-4 text-[11px] text-center text-slate-500 border border-dashed border-slate-700/50 rounded-lg py-2.5 bg-slate-900/30">
                Switch to <span className="text-indigo-400">Manual Simulation</span> above to adjust these values
              </p>
            )}
          </div>
        </section>

        {/* Topology */}
        <section className="lg:col-span-5 glass-panel rounded-2xl relative flex flex-col min-h-[420px] overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-800/80 flex justify-between items-center z-20 bg-slate-950/40 backdrop-blur-sm">
            <h2 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
              <Server className="w-4 h-4 text-indigo-400" /> Active Network Topology
            </h2>
            {routeFlash && prevOptimalNode && (
              <span className="text-[10px] font-mono px-2 py-1 rounded-full bg-amber-500/15 text-amber-200 border border-amber-500/30 animate-pulse">
                Rerouting: {prevOptimalNode} → {optimalNode}
              </span>
            )}
          </div>

          <div className="flex-1 relative flex items-center justify-center p-6 mt-4">
            <div
              className="absolute inset-0 opacity-[0.05]"
              style={{
                backgroundImage: "radial-gradient(circle, #6366f1 1.5px, transparent 1.5px)",
                backgroundSize: "32px 32px",
              }}
            />

            <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
              {nodes.map((node, i) => {
                const pos = getNodePosition(i, nodes.length);
                const isOptimal = node.node_name === optimalNode && isRouteReady;
                const wasPrev = node.node_name === prevOptimalNode && routeFlash;

                return (
                  <g key={node.id}>
                    {/* Path to node */}
                    <line
                      x1="50"
                      y1="50"
                      x2={pos.lineEndX}
                      y2={pos.lineEndY}
                      stroke={isOptimal ? "#38bdf8" : wasPrev ? "#f59e0b" : "#475569"}
                      strokeWidth={isOptimal ? 1.2 : 0.4}
                      strokeOpacity={isOptimal ? 1 : wasPrev ? 0.6 : 0.3}
                      strokeDasharray={isOptimal ? "none" : "2 2"}
                    />
                    
                    {/* Traffic Particles */}
                    {isRouteReady && (
                      <>
                        {/* Traffic to optimal node */}
                        {isOptimal && (
                          <>
                            <line
                              x1="50"
                              y1="50"
                              x2={pos.lineEndX}
                              y2={pos.lineEndY}
                              stroke="#38bdf8"
                              strokeWidth={3}
                              strokeOpacity={0.15}
                            />
                            <circle r="1.4" fill="#38bdf8">
                              <animateMotion dur="0.8s" repeatCount="indefinite" path={`M50,50 L${pos.lineEndX},${pos.lineEndY}`} />
                            </circle>
                            <circle r="1" fill="#bae6fd">
                              <animateMotion dur="0.8s" begin="0.25s" repeatCount="indefinite" path={`M50,50 L${pos.lineEndX},${pos.lineEndY}`} />
                            </circle>
                            <circle r="1" fill="#bae6fd">
                              <animateMotion dur="0.8s" begin="0.55s" repeatCount="indefinite" path={`M50,50 L${pos.lineEndX},${pos.lineEndY}`} />
                            </circle>
                          </>
                        )}
                        
                        {/* Smaller health-check background traffic to non-optimal nodes */}
                        {!isOptimal && (
                          <circle r="0.6" fill="#94a3b8">
                            <animateMotion dur="2.5s" repeatCount="indefinite" path={`M50,50 L${pos.lineEndX},${pos.lineEndY}`} />
                          </circle>
                        )}
                      </>
                    )}
                  </g>
                );
              })}
            </svg>

            {/* Central Hub */}
            <div className="relative z-10 flex flex-col items-center">
              <div
                className={`w-20 h-20 rounded-full flex items-center justify-center border-2 transition-all duration-500 ${
                  routeFlash ? "border-amber-400/80 shadow-[0_0_40px_rgba(251,191,36,0.4)]" : "border-indigo-500/60 shadow-[0_0_30px_rgba(99,102,241,0.3)]"
                } bg-slate-950`}
              >
                <Zap className={`w-8 h-8 ${routeFlash ? "text-amber-400" : "text-indigo-400"} animate-pulse`} />
              </div>
              <div className="mt-3 text-center bg-slate-950/80 px-3 py-1 rounded-md border border-slate-800">
                <span className="block text-[11px] font-bold tracking-widest text-indigo-400">LOAD BALANCER</span>
                <span className="block text-[10px] font-mono text-slate-400 mt-1 sm:hidden md:block">
                  Receiving {simulator.active_connection_count} conns
                </span>
              </div>
            </div>

            {/* Edge Nodes */}
            {nodes.map((node, i) => {
              const pos = getNodePosition(i, nodes.length);
              const isOptimal = node.node_name === optimalNode && isRouteReady;
              const pred = nodePredictions.find((p) => p.node_name === node.node_name);
              
              // Distribute traffic for visual effect: 90% routing to optimal, 10% health checks/baseline across rest
              let distributedConns = 0;
              if (isRouteReady) {
                 distributedConns = isOptimal 
                  ? Math.floor(simulator.active_connection_count * 0.9)
                  : Math.floor((simulator.active_connection_count * 0.1) / Math.max(1, nodes.length - 1));
              }

              const isHovered = hoveredNode === node.node_name;
              
              // Get current simulation state for this specific node
              const sim = serverSimulators[node.node_name] || (() => {
                 const factor = NODE_LOAD_FACTORS[node.node_name] ?? 1;
                 return buildNodeSnapshot(node.node_name, simulator, factor);
              })();

              return (
                <div
                  key={node.id}
                  onMouseEnter={() => setHoveredNode(node.node_name)}
                  onMouseLeave={() => setHoveredNode(null)}
                  className={`absolute z-30 w-[160px] rounded-xl border p-3.5 transition-all duration-300 backdrop-blur-xl ${
                    isOptimal
                      ? "bg-blue-950/90 border-blue-400/60 shadow-[0_4px_30px_rgba(56,189,248,0.25)] scale-105"
                      : "bg-slate-950/80 border-slate-700/60 opacity-80 hover:opacity-100 hover:scale-100 scale-[0.95]"
                  } ${isHovered ? "z-50 ring-2 ring-indigo-500/50 shadow-2xl" : ""}`}
                  style={{ transform: `translate(${pos.cardX}px, ${pos.cardY}px)` }}
                >
                  <div className="flex justify-between items-start gap-1 mb-2">
                    <span className={`text-[12px] font-bold truncate ${isOptimal ? "text-blue-100" : "text-slate-300"}`}>
                      {node.node_name}
                    </span>
                    {isOptimal ? (
                      <ArrowRightLeft className="w-4 h-4 text-blue-400 shrink-0 animate-pulse" />
                    ) : (
                      getStatusIcon(node.status)
                    )}
                  </div>
                  
                  {isOptimal ? (
                    <p className="text-[10px] uppercase tracking-wider text-blue-400 font-bold mb-2 flex items-center gap-1.5 bg-blue-500/10 w-fit px-2 py-0.5 rounded">
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-ping" />
                      Receiving Traffic
                    </p>
                  ) : (
                    <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">
                      Standby
                    </p>
                  )}
                  
                  <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden mb-2">
                    <div
                      className={`h-full rounded-full transition-all ${isOptimal ? "bg-blue-400 shadow-[0_0_10px_#60a5fa]" : "bg-slate-500"}`}
                      style={{ width: `${node.current_load_percentage}%` }}
                    />
                  </div>
                  
                  {isHovered && isManualMode ? (
                    <div className="flex flex-col gap-2mt-2 pt-2 border-t border-slate-700/50">
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-[9px] uppercase tracking-widest text-indigo-400 font-bold">Simulator</span>
                        {pred && <span className="text-[10px] font-mono text-emerald-400">{pred.predicted_delay_ms.toFixed(1)}ms</span>}
                      </div>
                      {(
                        [
                          { key: "active_connection_count" as const, label: "Conns", max: 10000, step: 50 },
                          { key: "queue_backlog_size" as const, label: "Queue", max: 1000, step: 10 },
                          { key: "regional_demand_index" as const, label: "Demand", max: 10, step: 0.1 }
                        ] as const
                      ).map(({ key, label, max, step }) => (
                        <div key={key} className="flex flex-col gap-1">
                          <div className="flex justify-between text-[9px] text-slate-400 items-center">
                            <span>{label}</span>
                            <span className="font-mono text-slate-300 font-bold bg-slate-800 px-1 rounded">
                              {key === "regional_demand_index" ? sim[key].toFixed(1) : sim[key]}
                            </span>
                          </div>
                          <input 
                            type="range" 
                            min={0} max={max} step={step} 
                            value={sim[key]} 
                            onChange={(e) => handleServerSliderChange(e, node.node_name, key)}
                            className="w-full h-1 bg-slate-800 rounded-full cursor-pointer appearance-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:bg-indigo-400 [&::-webkit-slider-thumb]:rounded-full hover:bg-slate-700 transition-colors"
                          />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex flex-col gap-0.5 text-[10px] font-mono text-slate-400">
                      <div className="flex justify-between">
                        <span>Server Load:</span>
                        <span className={isOptimal ? "text-blue-200" : ""}>{Math.round(node.current_load_percentage)}%</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Connections:</span>
                        <span className={isOptimal ? "text-emerald-300 font-bold" : ""}>{distributedConns.toLocaleString()}</span>
                      </div>
                      {pred && (
                        <div className="flex justify-between">
                          <span>Predict Latency:</span>
                          <span>{pred.predicted_delay_ms.toFixed(1)}ms</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mx-4 mb-4 p-3 rounded-xl bg-blue-500/10 border border-blue-500/30 z-10 backdrop-blur-md">
            <p className="text-[10px] uppercase tracking-widest text-blue-300/80 mb-1 flex items-center gap-2">
              <Activity className="w-3 h-3" /> System Action
            </p>
            <p className={`text-sm font-medium ${isRouteReady ? "text-blue-100" : "animate-pulse text-slate-400"}`}>
              {isRouteReady ? `All ingress traffic seamlessly routed to ${optimalNode} for optimal speed.` : "AI analyzing cluster status & predicting latencies…"}
            </p>
          </div>
        </section>

        {/* Logs - scrollable container */}
        <section className="lg:col-span-4 flex flex-col min-h-0">
          <div className="glass-panel rounded-2xl flex flex-col flex-1 min-h-[320px] overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800/80 flex items-center justify-between bg-slate-900/50 shrink-0">
              <span className="text-xs font-mono text-slate-400 flex items-center gap-2">
                <Terminal className="w-4 h-4 text-emerald-400" />
                Live Event Stream
              </span>
              <div className="flex gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-rose-500/80" />
                <span className="w-2.5 h-2.5 rounded-full bg-amber-500/80" />
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/80" />
              </div>
            </div>
            
            <div className="flex-1 p-4 overflow-y-auto font-mono text-[11px] space-y-2.5 bg-black/20">
              {logs.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-slate-600 gap-2">
                  <Activity className="w-6 h-6 animate-pulse" />
                  <p className="italic">Awaiting system events…</p>
                </div>
              )}
              {logs.map((log) => (
                <div key={log.id} className="flex gap-2.5 leading-relaxed break-words border-b border-white/5 pb-2 last:border-0">
                  <span className="text-slate-500 shrink-0 select-none">
                    [{new Date(log.timestamp).toLocaleTimeString([], { hour12: false })}]
                  </span>
                  <span
                    className={
                      log.type === "prediction"
                        ? "text-emerald-300"
                        : log.type === "routing"
                          ? "text-blue-300 font-bold"
                          : log.type === "alert"
                            ? "text-rose-400 font-bold"
                            : log.type === "metric"
                              ? "text-sky-200"
                              : "text-slate-300"
                    }
                  >
                    {log.message}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
