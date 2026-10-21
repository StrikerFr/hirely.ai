import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/lib/auth-middleware";
import { supabase } from "@/lib/db.server";
import { v4 as uuidv4 } from "uuid";

const PrepInput = z.object({
  resumeId: z.string().optional(),
  roleTarget: z.string().min(1).max(120),
  experienceLevel: z.enum(["Intern", "Junior", "Mid", "Senior", "Staff", "Principal"]).optional(),
  companyType: z.enum(["Startup", "Mid-size", "Enterprise", "Remote", "Hybrid", "Any"]).optional(),
  mode: z.enum(["HR", "Technical", "Behavioral", "Mixed", "Mock Final"]).default("Mixed"),
  jdText: z.string().max(20000).optional(),
});

export const savePrep = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((d: unknown) => PrepInput.parse(d))
  .handler(async ({ data, context }) => {
    const { groqJson } = await import("@/lib/groq.server");
    let jdAnalysis: any = null;
    if (data.jdText && data.jdText.trim().length > 30) {
      let resumeCtx = "";
      if (data.resumeId) {
        const { data: r } = await supabase.from('resumes').select('structured, raw_text').eq('id', data.resumeId).eq('user_id', context.userId).maybeSingle();
        if (r) resumeCtx = (typeof r.structured === 'string' ? r.structured : JSON.stringify(r.structured ?? {})) + "\n\n" + (r.raw_text ?? "").slice(0, 4000);
      }
      jdAnalysis = await groqJson<any>({
        system: `You are an expert recruiter comparing a candidate resume to a job description. Return JSON:
{
  "match_percent": number (0-100),
  "matching_skills": [strings],
  "missing_skills": [strings],
  "missing_keywords": [strings],
  "priority_improvements": [strings],
  "interview_focus_areas": [strings — the 4-6 topics THIS interview should probe]
}
Be specific to both the resume and the JD; no generic advice.`,
        user: `Job description:\n${data.jdText}\n\nResume context:\n${resumeCtx || "(no resume provided)"}`,
      });
    }

    const id = uuidv4();
    await supabase.from('interview_preps').insert({
      id, 
      user_id: context.userId, 
      resume_id: data.resumeId ?? null, 
      role_target: data.roleTarget,
      experience_level: data.experienceLevel ?? null, 
      company_type: data.companyType ?? null, 
      mode: data.mode,
      jd_text: data.jdText ?? null, 
      jd_analysis: jdAnalysis
    });

    return { prepId: id, jdAnalysis };
  });

export const getPrep = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator((d: unknown) => z.object({ id: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: p } = await supabase.from('interview_preps').select('*').eq('id', data.id).eq('user_id', context.userId).maybeSingle();
    if (!p) return null;
    return {
      ...p,
      jd_analysis: typeof p.jd_analysis === 'string' ? safeJson(p.jd_analysis) : p.jd_analysis,
    };
  });

function safeJson(s: string) { try { return JSON.parse(s); } catch { return null; } }
