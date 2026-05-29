import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://fallback.supabase.co';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'fallback-key';

// Create a reusable single database connection client
export const supabase = createClient(supabaseUrl, supabaseAnonKey);