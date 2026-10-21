import { createServerFn } from "@tanstack/react-start";
import { setCookie } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth-middleware";
import { supabase } from "@/lib/db.server";
import { v4 as uuidv4 } from "uuid";

export const getMyProfile = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('user_id', context.userId)
      .single();
      
    if (error && error.code !== 'PGRST116') {
      console.error(error);
    }
    
    return {
      userId: context.userId,
      email: context.email,
      profile,
      roles: [profile?.role || "candidate"],
    };
  });

const RoleInput = z.object({ role: z.enum(["candidate", "recruiter"]) });

export const setMyRole = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((d: unknown) => RoleInput.parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await supabase
      .from('profiles')
      .update({ role: data.role })
      .eq('user_id', context.userId);
      
    if (error) throw new Error(error.message);
    
    return { ok: true, role: data.role };
  });

const LoginInput = z.object({ email: z.string().email(), role: z.enum(["candidate", "recruiter"]).optional() });

export const mockLogin = createServerFn({ method: "POST" })
  .validator((d: unknown) => LoginInput.parse(d))
  .handler(async ({ data }) => {
    let { data: profile, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('email', data.email)
      .single();
      
    if (!profile) {
      const id = uuidv4();
      const role = data.role || "candidate";
      const name = data.email.split("@")[0];
      
      const { data: newProfile, error: insertError } = await supabase
        .from('profiles')
        .insert({ user_id: id, email: data.email, name, role })
        .select()
        .single();
        
      if (insertError) throw new Error(insertError.message);
      profile = newProfile;
    }
    
    setCookie("userId", profile.user_id, {
      maxAge: 60 * 60 * 24 * 30, // 30 days
      path: "/",
      httpOnly: true,
      sameSite: "lax",
    });
    
    return { ok: true };
  });

export const mockLogout = createServerFn({ method: "POST" })
  .handler(async () => {
    setCookie("userId", "", { maxAge: 0, path: "/" });
    return { ok: true };
  });
