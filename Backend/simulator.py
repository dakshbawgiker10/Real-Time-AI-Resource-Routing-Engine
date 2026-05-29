import asyncio
import random
import time

import httpx
from supabase import Client, create_client

SUPABASE_URL = "https://gibbkisnhbbiewhilaho.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdpYmJraXNuaGJiaWV3aGlsYWhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5MDA3NjMsImV4cCI6MjA5NTQ3Njc2M30.n1qVhgaB_VoKgaGADGSvQ2ymbB6ayZGy8G82Sbiutdw"
FASTAPI_BASE = "http://127.0.0.1:8001"
FASTAPI_PREDICT_URL = f"{FASTAPI_BASE}/predict-delay"
FASTAPI_ROUTING_URL = f"{FASTAPI_BASE}/update-routing-decision"
CYCLE_SECONDS = 3

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


def get_active_nodes():
    response = supabase.table("system_nodes").select("id, node_name").execute()
    return response.data


def seed_data():
    print("Database is empty. Seeding initial nodes...")
    nodes = [
        {"node_name": "US-East-Alpha", "status": "idle", "current_load_percentage": 0.0},
        {"node_name": "EU-West-Core", "status": "idle", "current_load_percentage": 0.0},
        {"node_name": "AP-South-Opt", "status": "idle", "current_load_percentage": 0.0},
    ]
    supabase.table("system_nodes").insert(nodes).execute()
    print("Nodes seeded successfully.")


def local_delay_estimate(payload: dict) -> float:
    conns = float(payload["active_connection_count"])
    backlog = float(payload["queue_backlog_size"])
    demand = float(payload["regional_demand_index"])
    time_w = float(payload["historical_time_weight"])
    return round(
        8.0
        + (min(conns / 10000.0, 1.0) * 120.0)
        + (min(backlog / 1000.0, 1.0) * 55.0)
        + (demand / 10.0 * 18.0)
        + (time_w / 2400.0 * 10.0),
        2,
    )


async def predict_delay_async(client: httpx.AsyncClient, payload: dict) -> float:
    try:
        response = await client.post(FASTAPI_PREDICT_URL, json=payload, timeout=10.0)
        if response.status_code == 200:
            delay = float(response.json().get("predicted_delay_ms", 0))
            if delay > 0:
                return delay
    except Exception as exc:
        print(f"Could not contact FastAPI Brain: {exc}")
    return local_delay_estimate(payload)


async def update_routing_decision_async(client: httpx.AsyncClient, cluster_snapshot: list[dict]) -> None:
    try:
        response = await client.post(
            FASTAPI_ROUTING_URL,
            json={"cluster_snapshot": cluster_snapshot},
            timeout=10.0,
        )
        if response.status_code == 200:
            result = response.json()
            print(
                f"AI Routing Decision: Route traffic to -> {result['optimal_node']} "
                f"(predicted delay: {result['lowest_predicted_delay_ms']:.2f} ms)"
            )
        else:
            print(f"Routing endpoint returned status {response.status_code}")
    except Exception as exc:
        print(f"Could not contact Routing Decision Engine: {exc}")


async def run_traffic_simulator_async() -> None:
    print("Live Production Traffic Simulator Initiated...")
    nodes = get_active_nodes()

    if not nodes:
        seed_data()
        nodes = get_active_nodes()

    iteration = 0

    async with httpx.AsyncClient() as http_client:
        while True:
            iteration += 1
            print(f"\n--- Traffic Cycle #{iteration} ---")

            mock_time_weight = (iteration * 10) % 2400
            cluster_snapshot: list[dict] = []

            for node in nodes:
                if iteration % 5 == 0:
                    print(f"Simulated Traffic Flash-Spike hitting {node['node_name']}!")
                    active_connections = random.randint(7000, 10000)
                    queue_backlog = random.randint(450, 900)
                    regional_demand = round(random.uniform(7.5, 9.8), 2)
                else:
                    active_connections = random.randint(500, 3000)
                    queue_backlog = random.randint(10, 120)
                    regional_demand = round(random.uniform(1.2, 5.5), 2)

                payload = {
                    "active_connection_count": active_connections,
                    "queue_backlog_size": queue_backlog,
                    "regional_demand_index": regional_demand,
                    "historical_time_weight": mock_time_weight,
                }

                predicted_delay = await predict_delay_async(http_client, payload)
                print(
                    f"PyTorch Prediction for {node['node_name']}: "
                    f"{predicted_delay:.2f} ms delay"
                )

                computed_load = min(100.0, (active_connections / 10000) * 100)
                node_status = "healthy"
                if computed_load > 75.0:
                    node_status = "critical"
                elif computed_load > 40.0:
                    node_status = "degraded"

                supabase.table("system_nodes").update(
                    {
                        "current_load_percentage": round(computed_load, 2),
                        "status": node_status,
                    }
                ).eq("id", node["id"]).execute()

                supabase.table("metrics_history_log").insert(
                    {
                        "node_id": node["id"],
                        "active_connection_count": active_connections,
                        "queue_backlog_size": queue_backlog,
                        "regional_demand_index": regional_demand,
                        "historical_time_weight": mock_time_weight,
                        "actual_processing_delay_ms": predicted_delay,
                    }
                ).execute()

                cluster_snapshot.append(
                    {
                        "node_name": node["node_name"],
                        "active_connection_count": active_connections,
                        "queue_backlog_size": queue_backlog,
                        "regional_demand_index": regional_demand,
                        "historical_time_weight": mock_time_weight,
                    }
                )

            await update_routing_decision_async(http_client, cluster_snapshot)
            await asyncio.sleep(CYCLE_SECONDS)


def run_traffic_simulator() -> None:
    asyncio.run(run_traffic_simulator_async())


if __name__ == "__main__":
    run_traffic_simulator()
