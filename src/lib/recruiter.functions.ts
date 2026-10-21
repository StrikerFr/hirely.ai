import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/lib/auth-middleware";
import { supabase } from "@/lib/db.server";
import { v4 as uuidv4 } from "uuid";

const StageInput = z.object({
  candidateId: z.string(),
  jobId: z.string().optional(),
  stage: z.enum(["Applied", "Screening", "Interview", "Offer", "Hired"]),
});

export const setPipelineStage = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((d: unknown) => StageInput.parse(d))
  .handler(async ({ data, context }) => {
    let query = supabase.from('pipeline_stages').select('id').eq('recruiter_id', context.userId).eq('candidate_id', data.candidateId);
    if (data.jobId) query = query.eq('job_id', data.jobId);
    else query = query.is('job_id', null);
    
    const { data: existing } = await query.maybeSingle();

    if (existing) {
      await supabase.from('pipeline_stages').update({ stage: data.stage, updated_at: new Date().toISOString() }).eq('id', existing.id);
    } else {
      await supabase.from('pipeline_stages').insert({
        id: uuidv4(), 
        recruiter_id: context.userId, 
        candidate_id: data.candidateId, 
        job_id: data.jobId || null, 
        stage: data.stage
      });
    }
    return { ok: true };
  });

export const getPipeline = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { data: stagesData } = await supabase.from('pipeline_stages').select('*').eq('recruiter_id', context.userId);
    const stages = stagesData || [];
    
    return await Promise.all(stages.map(async (s) => {
      const { data: profile } = await supabase.from('profiles').select('user_id, name, email, headline').eq('user_id', s.candidate_id).maybeSingle();
      const { data: analysis } = await supabase.from('resume_analyses').select('overall_score').eq('user_id', s.candidate_id).order('created_at', { ascending: false }).limit(1).maybeSingle();
      return {
        ...s,
        profile: profile ?? null,
        score: analysis?.overall_score ?? null,
      };
    }));
  });

export const recruiterAnalytics = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    if (context.role !== "recruiter") throw new Error("Recruiter role required");

    const { count: resumesCount } = await supabase.from('resumes').select('*', { count: 'exact', head: true });
    const { count: interviewsCount } = await supabase.from('interviews').select('*', { count: 'exact', head: true });
    const resumes = resumesCount || 0;
    const interviews = interviewsCount || 0;
    
    const { data: stagesData } = await supabase.from('pipeline_stages').select('stage').eq('recruiter_id', context.userId);
    const stages = stagesData || [];
    
    const eightyFourDaysAgo = new Date(Date.now() - 84 * 24 * 60 * 60 * 1000).toISOString();
    const { data: eventsData } = await supabase.from('resumes').select('created_at').gte('created_at', eightyFourDaysAgo);
    const events = eventsData || [];

    const funnel = {
      Applications: resumes,
      Screening: stages.filter((s) => s.stage === "Screening").length,
      Interview: stages.filter((s) => s.stage === "Interview").length,
      Offer: stages.filter((s) => s.stage === "Offer").length,
      Hired: stages.filter((s) => s.stage === "Hired").length,
    };

    const weeks: Record<string, number> = {};
    for (let i = 11; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i * 7);
      const key = d.toISOString().slice(0, 10);
      weeks[key] = 0;
    }
    for (const e of events) {
      if (!e.created_at) continue;
      const d = new Date(e.created_at);
      const weekIdx = Math.floor((Date.now() - d.getTime()) / (7 * 24 * 3600 * 1000));
      const targetIdx = 11 - weekIdx;
      const keys = Object.keys(weeks);
      if (targetIdx >= 0 && targetIdx < keys.length) weeks[keys[targetIdx]]++;
    }

    return {
      funnel,
      trend: Object.entries(weeks).map(([week, count]) => ({ week, count })),
      totals: { resumes, interviews },
    };
  });
