from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

app = FastAPI(
    title="Real-Time AI Predictive Resource Routing Engine",
    version="5.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Optional PyTorch — never block latency math if import or weights fail
brain = None
try:
    import torch
    from model import PredictiveRoutingBrain

    brain = PredictiveRoutingBrain()
    weights_path = Path(__file__).parent / "routing_model.pth"
    if weights_path.exists():
        brain.load_state_dict(torch.load(weights_path, map_location="cpu"))
        print(f"[engine] Loaded weights from {weights_path}")
    else:
        print("[engine] No routing_model.pth — heuristic latency model active")
    brain.eval()
except Exception as exc:
    print(f"[engine] PyTorch unavailable ({exc}) — heuristic latency model active")


class TelemetryDataInput(BaseModel):
    active_connection_count: float = Field(..., ge=0)
    queue_backlog_size: float = Field(..., ge=0)
    regional_demand_index: float = Field(..., ge=0, le=10)
    historical_time_weight: float = Field(..., ge=0, le=2400)


class NodeMetricsSnapshot(BaseModel):
    node_name: str
    active_connection_count: float = Field(..., ge=0)
    queue_backlog_size: float = Field(..., ge=0)
    regional_demand_index: float = Field(..., ge=0, le=10)
    historical_time_weight: float = Field(..., ge=0, le=2400)


class ClusterRoutingRequest(BaseModel):
    cluster_snapshot: List[NodeMetricsSnapshot]


routing_cache: dict = {
    "optimal_node": "Calculating...",
    "lowest_predicted_delay_ms": None,
    "all_predictions": [],
}


def _normalize(conns: float, backlog: float, demand: float, time_w: float) -> List[float]:
    return [
        min(conns / 10000.0, 1.0),
        min(backlog / 1000.0, 1.0),
        demand / 10.0,
        time_w / 2400.0,
    ]


def compute_predicted_delay_ms(conns: float, backlog: float, demand: float, time_w: float) -> float:
    """Always returns realistic latency in ms (never zero)."""
    n_conns, n_backlog, n_demand, n_time = _normalize(conns, backlog, demand, time_w)
    heuristic = (
        8.0
        + n_conns * 120.0
        + n_backlog * 55.0
        + n_demand * 18.0
        + n_time * 10.0
    )

    nn_adjustment = 0.0
    if brain is not None:
        try:
            import torch

            tensor_input = torch.tensor([_normalize(conns, backlog, demand, time_w)], dtype=torch.float32)
            with torch.no_grad():
                nn_raw = float(brain(tensor_input).item())
            if abs(nn_raw) >= 0.05:
                nn_adjustment = abs(nn_raw) * 25.0
        except Exception:
            pass

    delay = heuristic * 0.85 + nn_adjustment
    return round(max(5.0, delay), 2)


@app.get("/health")
async def health_check():
    return {
        "status": "online",
        "engine": "heuristic+pytorch" if brain else "heuristic",
        "version": "5.0.0",
        "routing_cache": routing_cache,
    }


@app.post("/predict-delay")
async def predict_processing_delay(data: TelemetryDataInput):
    delay = compute_predicted_delay_ms(
        data.active_connection_count,
        data.queue_backlog_size,
        data.regional_demand_index,
        data.historical_time_weight,
    )
    return {"status": "success", "predicted_delay_ms": delay}


@app.get("/get-optimal-route")
async def get_optimal_route():
    return routing_cache


@app.post("/update-routing-decision")
async def update_routing_decision(request: ClusterRoutingRequest):
    global routing_cache

    if not request.cluster_snapshot:
        raise HTTPException(status_code=400, detail="cluster_snapshot cannot be empty")

    best_node: Optional[str] = None
    lowest_delay = float("inf")
    node_predictions = []

    for node in request.cluster_snapshot:
        delay = compute_predicted_delay_ms(
            node.active_connection_count,
            node.queue_backlog_size,
            node.regional_demand_index,
            node.historical_time_weight,
        )
        node_predictions.append({"node_name": node.node_name, "predicted_delay_ms": delay})
        if delay < lowest_delay:
            lowest_delay = delay
            best_node = node.node_name

    routing_cache = {
        "optimal_node": best_node or "Unknown",
        "lowest_predicted_delay_ms": round(lowest_delay, 2),
        "all_predictions": node_predictions,
    }

    return {
        "status": "success",
        "optimal_node": best_node,
        "lowest_predicted_delay_ms": round(lowest_delay, 2),
        "all_predictions": node_predictions,
    }
