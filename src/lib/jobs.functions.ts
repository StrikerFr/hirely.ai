import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/lib/auth-middleware";
import { supabase } from "@/lib/db.server";
import { v4 as uuidv4 } from "uuid";
import { cosineSimilarity } from "@/lib/vector-math";

const CreateJobInput = z.object({
  title: z.string().min(2).max(160),
  description: z.string().min(20).max(20000),
});

export const createJob = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((d: unknown) => CreateJobInput.parse(d))
  .handler(async ({ data, context }) => {
    const { groqJson } = await import("@/lib/groq.server");
    const { embed } = await import("@/lib/embeddings.server");

    // Extract structured requirements
    const req = await groqJson<{
      must_have_skills: string[];
      nice_to_have: string[];
      experience_years: number;
      seniority: string;
      keywords: string[];
    }>({
      system: `Extract structured requirements from the job description. Return JSON {must_have_skills[], nice_to_have[], experience_years, seniority, keywords[]}.`,
      user: data.description,
    });

    let vecStr: any = null;
    try {
      const vec = await embed(`${data.title}\n${data.description}\nSkills: ${req.must_have_skills.join(", ")}`);
      vecStr = vec;
    } catch (e) {
      console.warn("[job embed skipped]", (e as Error).message);
    }

    const jobId = uuidv4();
    await supabase.from('jobs').insert({
      id: jobId, 
      recruiter_id: context.userId, 
      title: data.title, 
      description: data.description, 
      requirements: req, 
      embedding: vecStr
    });

    const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
    return job;
  });

export const listJobs = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { data: jobsData } = await supabase
      .from('jobs')
      .select('id, title, description, requirements, created_at')
      .eq('recruiter_id', context.userId)
      .order('created_at', { ascending: false });
      
    const data = jobsData || [];
    return data.map(d => ({
      ...d,
      requirements: typeof d.requirements === 'string' ? JSON.parse(d.requirements) : d.requirements
    }));
  });

// Match a specific job against all resumes: embeds→cosine + Groq reasoning for top N.
const MatchInput = z.object({ jobId: z.string(), topN: z.number().int().min(1).max(50).default(10) });
export const matchJob = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((d: unknown) => MatchInput.parse(d))
  .handler(async ({ data }) => {
    const { groqJson } = await import("@/lib/groq.server");

    const { data: job } = await supabase.from('jobs').select('*, embedding').eq('id', data.jobId).single();
    if (!job) throw new Error("Job not found");
    if (!job.embedding) throw new Error("Job has no embedding yet");

    let jobVec: number[] = typeof job.embedding === 'string' ? JSON.parse(job.embedding) : job.embedding;

    const { data: allResumesData } = await supabase.from('resumes').select('id, user_id, structured, embedding').not('embedding', 'is', null);
    const allResumes = allResumesData || [];

    const candidates = allResumes.map(r => {
      let rVec: number[] = typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding;
      return {
        resume_id: r.id,
        user_id: r.user_id,
        similarity: cosineSimilarity(jobVec, rVec),
        structured: typeof r.structured === 'string' ? JSON.parse(r.structured) : r.structured
      };
    }).sort((a, b) => b.similarity - a.similarity).slice(0, data.topN);

    const results = [];
    for (const c of candidates) {
      const reasoning = await groqJson<{
        score: number;
        matching_skills: string[];
        missing_skills: string[];
        summary: string;
      }>({
        system: `Given a job and a resume, return JSON {score 0-100, matching_skills[], missing_skills[], summary (1-2 sentences)} explaining the fit.`,
        user: `Job title: ${job.title}\nRequirements: ${JSON.stringify(job.requirements)}\n\nResume: ${JSON.stringify(c.structured).slice(0, 5000)}`,
      });

      await supabase.from('job_matches').upsert({
        id: uuidv4(), 
        job_id: data.jobId, 
        resume_id: c.resume_id, 
        candidate_id: c.user_id, 
        score: Math.round(reasoning.score), 
        matching_skills: reasoning.matching_skills, 
        missing_skills: reasoning.missing_skills, 
        reasoning: reasoning.summary
      }, { onConflict: 'job_id,resume_id' });
      
      results.push({
        resume_id: c.resume_id,
        candidate_id: c.user_id,
        similarity: c.similarity,
        ...reasoning,
      });
    }
    return { jobId: data.jobId, results };
  });

