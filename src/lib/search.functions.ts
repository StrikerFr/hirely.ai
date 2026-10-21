import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/lib/auth-middleware";
import { supabase } from "@/lib/db.server";
import { v4 as uuidv4 } from "uuid";
import { cosineSimilarity } from "@/lib/vector-math";

const SearchInput = z.object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(50).default(20) });

export const searchCandidates = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((d: unknown) => SearchInput.parse(d))
  .handler(async ({ data, context }) => {
    const { embed } = await import("@/lib/embeddings.server");
    if (context.role !== "recruiter") throw new Error("Recruiter role required");

    const vec = await embed(data.query);

    const { data: allResumesData } = await supabase.from('resumes').select('id, user_id, structured, embedding').not('embedding', 'is', null);
    const allResumes = allResumesData || [];
    
    // Calculate cosine similarity in-memory
    const matches = allResumes.map(r => {
      let rVec: number[] = typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding;
      return {
        resume_id: r.id,
        user_id: r.user_id,
        similarity: cosineSimilarity(vec, rVec),
        structured: typeof r.structured === 'string' ? JSON.parse(r.structured) : r.structured
      };
    }).sort((a, b) => b.similarity - a.similarity).slice(0, data.limit);

    return await Promise.all(matches.map(async m => {
      const { data: profile } = await supabase.from('profiles').select('user_id, name, email, headline, avatar_url').eq('user_id', m.user_id).maybeSingle();
      const { data: analysis } = await supabase.from('resume_analyses').select('resume_id, overall_score, summary, strengths, gaps').eq('resume_id', m.resume_id).maybeSingle();
      return {
        ...m,
        candidate_id: m.user_id,
        profile,
        analysis: analysis ? {
          ...analysis,
          strengths: typeof analysis.strengths === 'string' ? JSON.parse(analysis.strengths) : (analysis.strengths || []),
          gaps: typeof analysis.gaps === 'string' ? JSON.parse(analysis.gaps) : (analysis.gaps || [])
        } : null
      };
    }));
  });

export const listAllCandidates = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    if (context.role !== "recruiter") throw new Error("Recruiter role required");
    const { data: resumesData } = await supabase.from('resumes').select('id, user_id, file_name, created_at, structured').order('created_at', { ascending: false }).limit(100);
    const resumes = resumesData || [];
    
    return await Promise.all(resumes.map(async r => {
      const { data: profile } = await supabase.from('profiles').select('user_id, name, email, headline').eq('user_id', r.user_id).maybeSingle();
      const { data: analysis } = await supabase.from('resume_analyses').select('overall_score, summary, strengths, gaps').eq('resume_id', r.id).maybeSingle();
      return {
        ...r,
        structured: typeof r.structured === 'string' ? JSON.parse(r.structured) : (r.structured || null),
        profile,
        resume_analyses: analysis ? [{
          ...analysis,
          strengths: typeof analysis.strengths === 'string' ? JSON.parse(analysis.strengths) : (analysis.strengths || []),
          gaps: typeof analysis.gaps === 'string' ? JSON.parse(analysis.gaps) : (analysis.gaps || [])
        }] : []
      };
    }));
  });

export const compareCandidates = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((d: unknown) =>
    z.object({ resumeIdA: z.string(), resumeIdB: z.string(), jobDescription: z.string().max(4000).optional() }).parse(d)
  )
  .handler(async ({ data }) => {
    const { groqJson } = await import("@/lib/groq.server");
    const { data: a } = await supabase.from('resumes').select('structured, raw_text').eq('id', data.resumeIdA).maybeSingle();
    const { data: b } = await supabase.from('resumes').select('structured, raw_text').eq('id', data.resumeIdB).maybeSingle();
    
    const strA = typeof a?.structured === 'string' ? a.structured : JSON.stringify(a?.structured ?? {});
    const strB = typeof b?.structured === 'string' ? b.structured : JSON.stringify(b?.structured ?? {});
    
    return groqJson<{
      winner: "A" | "B" | "tie";
      reasoning: string;
      candidateA: { strengths: string[]; gaps: string[] };
      candidateB: { strengths: string[]; gaps: string[] };
    }>({
      system: `Compare two candidates for a role and return JSON {winner: "A"|"B"|"tie", reasoning, candidateA{strengths[],gaps[]}, candidateB{strengths[],gaps[]}}.`,
      user: `Job: ${data.jobDescription ?? "General senior role"}\n\nCandidate A: ${strA.slice(0, 4000)}\n\nCandidate B: ${strB.slice(0, 4000)}`,
    });
  });

const EmailInput = z.object({
  candidateId: z.string(),
  resumeId: z.string(),
  jobContext: z.string().max(2000).optional(),
  tone: z.enum(["warm", "direct", "casual", "executive"]).default("warm"),
});

export const draftOutreachEmail = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((d: unknown) => EmailInput.parse(d))
  .handler(async ({ data, context }) => {
    const { groqJson } = await import("@/lib/groq.server");
    const { data: resume } = await supabase.from('resumes').select('structured').eq('id', data.resumeId).maybeSingle();
    const { data: profile } = await supabase.from('profiles').select('name, email').eq('user_id', data.candidateId).maybeSingle();

    const strResume = typeof resume?.structured === 'string' ? resume.structured : JSON.stringify(resume?.structured ?? {});

    const email = await groqJson<{ subject: string; body: string }>({
      system: `Draft a personalized recruiter outreach email. Warm, specific to the candidate's projects/experience. Tone: ${data.tone}. Return JSON {subject, body}.`,
      user: `Candidate: ${profile?.name ?? "Candidate"}\nResume: ${strResume.slice(0, 3500)}\nJob context: ${data.jobContext ?? "Open role"}`,
    });

    await supabase.from('outreach_emails').insert({
      id: uuidv4(), 
      recruiter_id: context.userId, 
      candidate_id: data.candidateId, 
      subject: email.subject, 
      body: email.body
    });
    return email;
  });

