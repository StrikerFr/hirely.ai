import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/lib/auth-middleware";
import { supabase } from "@/lib/db.server";
import { v4 as uuidv4 } from "uuid";

const ANALYSIS_SCHEMA = `Return EXACTLY a JSON object with this shape:
{
  "overall_score": number (0-100),
  "ats_score": number (0-100),
  "clarity": number (0-100),
  "impact": number (0-100),
  "technical": number (0-100),
  "communication": number (0-100),
  "project_quality": number (0-100),
  "leadership": number (0-100),
  "problem_solving": number (0-100),
  "recruiter_appeal": number (0-100),
  "growth_potential": number (0-100),
  "confidence_prediction": number (0-100),
  "hiring_recommendation": "strong_hire" | "hire" | "maybe" | "no_hire",
  "career_level": "intern" | "junior" | "mid" | "senior" | "staff" | "principal",
  "years_experience": number,
  "summary": "2-3 sentence personalized recruiter-facing summary of THIS candidate",
  "strengths": [4-6 specific strings citing the resume],
  "gaps": [3-5 specific strings citing the resume],
  "ranking_explanation": "One paragraph explaining WHY this candidate scored this overall_score",
  "structured": {
    "name": "Full name extracted from resume",
    "email": "email or null",
    "phone": "phone or null",
    "location": "city / remote / null",
    "linkedin": "url or null",
    "github": "url or null",
    "portfolio": "url or null",
    "headline": "Candidate's main title/role",
    "summary": "Their own written summary (or synthesized)",
    "skills": {
      "languages": [strings],
      "frameworks": [strings],
      "libraries": [strings],
      "databases": [strings],
      "cloud": [strings],
      "tools": [strings],
      "soft": [strings]
    },
    "experience": [{"company": "string", "role": "string", "period": "string", "location": "string", "bullets": [strings]}],
    "projects": [{"name": "string", "description": "string", "tech": [strings], "impact": "string"}],
    "education": [{"school": "string", "degree": "string", "period": "string"}],
    "certifications": [strings],
    "achievements": [strings],
    "languages_spoken": [strings]
  }
}
Every insight must be specific to this exact resume. No generic filler.`;

const UploadInput = z.object({
  fileName: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(120),
  contentBase64: z.string().min(10),
});

// Recruiter uploads a resume; we analyze it and store it under the recruiter's user_id.
export const recruiterUploadResume = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((d: unknown) => UploadInput.parse(d))
  .handler(async ({ data, context }) => {
    if (context.role !== "recruiter") throw new Error("Recruiter role required");
    const { extractResumeText } = await import("@/lib/resume-parser.server");
    const { geminiOcr } = await import("@/lib/gemini.server");
    const { groqJson } = await import("@/lib/groq.server");
    const { embed } = await import("@/lib/embeddings.server");

    const bin = Uint8Array.from(atob(data.contentBase64), (c) => c.charCodeAt(0));
    if (bin.byteLength > 10 * 1024 * 1024) throw new Error("File exceeds 10MB");

    const resumeId = uuidv4();
    const safeName = data.fileName.replace(/[^a-z0-9.\-_]/gi, "_");
    const rel = `${context.userId}-${Date.now()}-${safeName}`;
    
    const { error: uploadErr } = await supabase.storage.from('resumes').upload(rel, bin, {
      contentType: data.mimeType
    });
    if (uploadErr) throw new Error("Failed to upload resume to storage: " + uploadErr.message);

    let raw = "";
    if (data.mimeType.startsWith("image/")) {
      raw = await geminiOcr(data.contentBase64, data.mimeType);
    } else {
      raw = await extractResumeText(bin.buffer as ArrayBuffer, data.mimeType, data.fileName);
    }
    if (!raw || raw.trim().length < 30) throw new Error("Could not extract meaningful text from resume");
    raw = raw.slice(0, 30000);

    const analysis = await groqJson<any>({
      system: `You are Hirely.ai, an elite AI recruiter analyzing a resume for a hiring manager.\n${ANALYSIS_SCHEMA}`,
      user: `Resume text:\n\n${raw}`,
    });

    let vec: any = null;
    try {
      const structured = analysis.structured ?? {};
      const skillsFlat = Object.values(structured.skills ?? {}).flat().join(", ");
      vec = await embed(
        `${structured.headline ?? ""}\n${analysis.summary ?? ""}\nSkills: ${skillsFlat}\n${raw.slice(0, 4000)}`
      );
    } catch {}

    // Store resume under recruiter's user_id so it belongs to their private pool.
    await supabase.from('resumes').insert({
      id: resumeId, 
      user_id: context.userId, 
      uploader_id: context.userId, 
      file_name: data.fileName, 
      storage_path: rel, 
      mime_type: data.mimeType, 
      raw_text: raw, 
      structured: analysis.structured ?? {}, 
      embedding: vec, 
      label: "Uploaded", 
      recruiter_status: 'needs_review'
    });

    await supabase.from('resume_analyses').insert({
      id: uuidv4(), 
      resume_id: resumeId, 
      user_id: context.userId,
      overall_score: Math.round(analysis.overall_score ?? 0),
      ats_score: Math.round(analysis.ats_score ?? 0),
      clarity: Math.round(analysis.clarity ?? 0),
      impact: Math.round(analysis.impact ?? 0),
      summary: analysis.summary ?? "",
      strengths: analysis.strengths ?? [],
      gaps: analysis.gaps ?? [],
      roadmap: [],
      raw: analysis
    });

    return {
      resumeId,
      name: analysis.structured?.name ?? data.fileName,
      score: Math.round(analysis.overall_score ?? 0),
    };
  });

export const listRecruiterCandidates = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    if (context.role !== "recruiter") throw new Error("Recruiter role required");
    
    // Show all resumes the recruiter uploaded OR (fallback) all resumes if uploader tracking is missing.
    const { data: rowsData } = await supabase
      .from('resumes')
      .select('id, file_name, created_at, structured, recruiter_status, recruiter_notes, mime_type')
      .or(`uploader_id.eq.${context.userId},uploader_id.is.null`)
      .order('created_at', { ascending: false })
      .limit(500);
      
    const rows = rowsData || [];

    return await Promise.all(rows.map(async (r) => {
      const { data: a } = await supabase
        .from('resume_analyses')
        .select('overall_score, ats_score, clarity, impact, summary, strengths, gaps, raw')
        .eq('resume_id', r.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
        
      const structured = typeof r.structured === 'string' ? safe(r.structured) : (r.structured || {});
      const raw = a?.raw ? (typeof a.raw === 'string' ? safe(a.raw) : a.raw) : {};
      
      return {
        resume_id: r.id,
        file_name: r.file_name,
        created_at: r.created_at,
        status: r.recruiter_status ?? 'needs_review',
        notes: r.recruiter_notes ?? '',
        structured,
        name: structured?.name ?? r.file_name,
        headline: structured?.headline ?? '',
        email: structured?.email ?? null,
        phone: structured?.phone ?? null,
        overall_score: a?.overall_score ?? 0,
        summary: a?.summary ?? '',
        strengths: typeof a?.strengths === 'string' ? safe(a.strengths) : (a?.strengths ?? []),
        gaps: typeof a?.gaps === 'string' ? safe(a.gaps) : (a?.gaps ?? []),
        analysis: raw,
      };
    }));
  });

export const getRecruiterCandidate = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator((d: unknown) => z.object({ id: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    if (context.role !== "recruiter") throw new Error("Recruiter role required");
    
    const { data: r } = await supabase.from('resumes').select('*').eq('id', data.id).maybeSingle();
    if (!r) return null;
    
    const { data: a } = await supabase.from('resume_analyses').select('*').eq('resume_id', r.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    
    return {
      resume_id: r.id,
      file_name: r.file_name,
      created_at: r.created_at,
      status: r.recruiter_status ?? 'needs_review',
      notes: r.recruiter_notes ?? '',
      raw_text: r.raw_text,
      structured: typeof r.structured === 'string' ? safe(r.structured) : (r.structured || {}),
      analysis: a ? {
        overall_score: a.overall_score,
        ats_score: a.ats_score,
        clarity: a.clarity,
        impact: a.impact,
        summary: a.summary,
        strengths: typeof a.strengths === 'string' ? safe(a.strengths) : (a.strengths ?? []),
        gaps: typeof a.gaps === 'string' ? safe(a.gaps) : (a.gaps ?? []),
        raw: typeof a.raw === 'string' ? safe(a.raw) : (a.raw ?? {}),
      } : null,
    };
  });

export const setCandidateStatus = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((d: unknown) => z.object({
    resumeId: z.string(),
    status: z.enum(["needs_review", "shortlisted", "rejected"]),
  }).parse(d))
  .handler(async ({ data, context }) => {
    if (context.role !== "recruiter") throw new Error("Recruiter role required");
    await supabase.from('resumes').update({ recruiter_status: data.status }).eq('id', data.resumeId);
    return { ok: true };
  });

export const setCandidateNotes = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((d: unknown) => z.object({
    resumeId: z.string(),
    notes: z.string().max(4000),
  }).parse(d))
  .handler(async ({ data, context }) => {
    if (context.role !== "recruiter") throw new Error("Recruiter role required");
    await supabase.from('resumes').update({ recruiter_notes: data.notes }).eq('id', data.resumeId);
    return { ok: true };
  });

export const deleteRecruiterCandidate = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((d: unknown) => z.object({ resumeId: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    if (context.role !== "recruiter") throw new Error("Recruiter role required");
    
    const { data: r } = await supabase.from('resumes').select('storage_path').eq('id', data.resumeId).maybeSingle();
    if (r?.storage_path) {
      await supabase.storage.from('resumes').remove([r.storage_path]);
    }
    
    await supabase.from('resume_analyses').delete().eq('resume_id', data.resumeId);
    await supabase.from('resumes').delete().eq('id', data.resumeId);
    
    return { ok: true };
  });

function safe(s: any) {
  if (typeof s !== "string") return s;
  try { return JSON.parse(s); } catch { return null; }
}
