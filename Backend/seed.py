from supabase import create_client
import os
from dotenv import load_dotenv

# Load from existing .env.local if present, else fallback
load_dotenv(".env.local")

SUPABASE_URL = os.getenv("NEXT_PUBLIC_SUPABASE_URL", "https://gibbkisnhbbiewhilaho.supabase.co")
SUPABASE_KEY = os.getenv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdpYmJraXNuaGJiaWV3aGlsYWhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5MDA3NjMsImV4cCI6MjA5NTQ3Njc2M30.n1qVhgaB_VoKgaGADGSvQ2ymbB6ayZGy8G82Sbiutdw")

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

def seed_nodes():
    existing = supabase.table("system_nodes").select("id").execute()
    if existing.data and len(existing.data) > 0:
        print("Data already seeded.")
        return
    
    nodes = [
        {"node_name": "US-East-Alpha", "status": "idle", "current_load_percentage": 0.0},
        {"node_name": "EU-West-Core", "status": "idle", "current_load_percentage": 0.0},
        {"node_name": "AP-South-Opt", "status": "idle", "current_load_percentage": 0.0}
    ]
    
    response = supabase.table("system_nodes").insert(nodes).execute()
    print("Seeded successfully:", len(response.data), "nodes")

if __name__ == "__main__":
    seed_nodes()
