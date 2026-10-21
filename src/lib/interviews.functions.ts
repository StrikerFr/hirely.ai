import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/lib/auth-middleware";
import { supabase } from "@/lib/db.server";
import { v4 as uuidv4 } from "uuid";

type Turn = { idx: number; question: string; answer_transcript: string | null; evaluation: any | null; difficulty: number | null };

const MAX_QUESTIONS = 7;

const StartInput = z.object({
  prepId: z.string().optional(),
  resumeId: z.string().optional(),
  roleTarget: z.string().min(1).max(120),
  mode: z.enum(["HR", "Technical", "Behavioral", "Mixed", "Mock Final"]).default("Mixed"),
});

async function buildContext(userId: string, resumeId: string | null | undefined, prepId: string | null | undefined) {
  let resumeCtx = "";
  let jdCtx = "";
  let focusAreas: string[] = [];
  let coachMemory = "";
  if (resumeId) {
    const { data: r } = await supabase.from('resumes').select('structured, raw_text').eq('id', resumeId).eq('user_id', userId).maybeSingle();
    if (r) {
      const structuredStr = typeof r.structured === 'string' ? r.structured : JSON.stringify(r.structured);
      resumeCtx = ((structuredStr ?? "") + "\n" + (r.raw_text ?? "")).slice(0, 5000);
    }
  }
  if (prepId) {
    const { data: p } = await supabase.from('interview_preps').select('jd_text, jd_analysis').eq('id', prepId).eq('user_id', userId).maybeSingle();
    if (p) {
      jdCtx = (p.jd_text ?? "").slice(0, 3000);
      try {
        const a = typeof p.jd_analysis === 'string' ? JSON.parse(p.jd_analysis) : p.jd_analysis;
        if (a?.interview_focus_areas) focusAreas = a.interview_focus_areas;
      } catch {}
    }
  }
  const { data: prof } = await supabase.from('profiles').select('coach_memory').eq('user_id', userId).maybeSingle();
  if (prof?.coach_memory) coachMemory = prof.coach_memory.slice(0, 1500);
  return { resumeCtx, jdCtx, focusAreas, coachMemory };
}

export const startInterview = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((d: unknown) => StartInput.parse(d))
  .handler(async ({ data, context }) => {
    const { groqJson } = await import("@/lib/groq.server");
    const ctx = await buildContext(context.userId, data.resumeId, data.prepId);

    const interviewId = uuidv4();
    await supabase.from('interviews').insert({
      id: interviewId, 
      user_id: context.userId, 
      resume_id: data.resumeId ?? null, 
      role_target: data.roleTarget, 
      status: "active",
      prep_id: data.prepId ?? null, 
      mode: data.mode
    });

    const q = await groqJson<{ question: string }>({
      system: `You are a top-tier ${data.mode} interviewer for a ${data.roleTarget} role. Ask EXACTLY ONE opening question, tailored to this specific candidate's resume. Do not number the question. Do not ask multiple questions. Return JSON {question}.
Focus areas from JD (if any): ${focusList(ctx.focusAreas)}
Avoid repeating any topic the candidate has already covered in prior sessions (coach memory): ${ctx.coachMemory || "(none)"}.`,
      user: `Resume:\n${ctx.resumeCtx || "(none)"}\n\nJob description:\n${ctx.jdCtx || "(none)"}`,
    });

    await supabase.from('interview_turns').insert({
      id: uuidv4(), 
      interview_id: interviewId, 
      idx: 0, 
      question: q.question, 
      difficulty: 50
    });

    return { interviewId, question: q.question, idx: 0, mode: data.mode };
  });

const AnswerInput = z.object({
  interviewId: z.string(),
  idx: z.number().int().min(0),
  transcript: z.string().min(1).max(8000),
});

export const submitAnswer = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((d: unknown) => AnswerInput.parse(d))
  .handler(async ({ data, context }) => {
    const { groqJson } = await import("@/lib/groq.server");
    const { data: itv } = await supabase.from('interviews').select('id, role_target, mode, resume_id, prep_id').eq('id', data.interviewId).eq('user_id', context.userId).maybeSingle();
    if (!itv) throw new Error("Interview not found");

    const { data: currentTurn } = await supabase.from('interview_turns').select('question, difficulty').eq('interview_id', data.interviewId).eq('idx', data.idx).maybeSingle();
    const currentDifficulty = currentTurn?.difficulty ?? 50;

    const evaluation = await groqJson<any>({
      system: `You are a rigorous interview evaluator for a ${itv.role_target} ${itv.mode} interview. Score the answer 0-100 on every axis and return JSON:
{
  "technical_accuracy": number,
  "communication": number,
  "confidence": number,
  "clarity": number,
  "grammar": number,
  "completeness": number,
  "relevance": number,
  "professionalism": number,
  "star_usage": number,
  "structure": number,
  "overall": number,
  "strengths": [2-4 short bullets],
  "weaknesses": [2-4 short bullets],
  "how_to_improve": [2-4 concrete actions],
  "better_answer_example": "A concise example of a stronger answer (3-5 sentences)."
}`,
      user: `Question: ${currentTurn?.question}\n\nCandidate answer:\n${data.transcript}`,
    });

    await supabase.from('interview_turns').update({
      answer_transcript: data.transcript, 
      evaluation: evaluation
    }).eq('interview_id', data.interviewId).eq('idx', data.idx);

    const { data: prevTurnsData } = await supabase.from('interview_turns').select('idx, question, answer_transcript, evaluation, difficulty').eq('interview_id', data.interviewId).order('idx', { ascending: true });
    const prevTurns = (prevTurnsData || []) as Turn[];

    if (prevTurns.length >= MAX_QUESTIONS) {
      return { done: true, evaluation };
    }

    const overall = Number(evaluation.overall ?? 60);
    let nextDifficulty = currentDifficulty;
    if (overall >= 75) nextDifficulty = Math.min(95, currentDifficulty + 12);
    else if (overall < 50) nextDifficulty = Math.max(25, currentDifficulty - 10);

    const ctx = await buildContext(context.userId, itv.resume_id, itv.prep_id);
    const asked = prevTurns.map(t => t.question);

    const next = await groqJson<{ question: string }>({
      system: `You are a top-tier ${itv.mode} interviewer for a ${itv.role_target} role.
Adaptive rules:
- Target difficulty: ${nextDifficulty}/100 (higher = deeper follow-up / trickier scenario).
- If candidate is struggling, encourage briefly then simplify.
- If candidate is confident, probe deeper or shift to a weaker area.
Ask EXACTLY ONE next question. Do not number it. Do not repeat any topic already asked: ${JSON.stringify(asked).slice(0, 1500)}.
Return JSON {question}.`,
      user: `Prior turns: ${JSON.stringify(prevTurns).slice(0, 5000)}\n\nResume:\n${ctx.resumeCtx || "(none)"}\n\nJD focus areas: ${focusList(ctx.focusAreas)}`,
    });

    const nextIdx = data.idx + 1;
    await supabase.from('interview_turns').insert({
      id: uuidv4(), 
      interview_id: data.interviewId, 
      idx: nextIdx, 
      question: next.question, 
      difficulty: nextDifficulty
    });

    return { done: false, evaluation, question: next.question, idx: nextIdx, difficulty: nextDifficulty };
  });

export const finalizeInterview = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((d: unknown) => z.object({ interviewId: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    const { groqJson } = await import("@/lib/groq.server");

    const { data: turnsData } = await supabase.from('interview_turns').select('idx, question, answer_transcript, evaluation').eq('interview_id', data.interviewId).order('idx', { ascending: true });
    const turns = turnsData || [];
    
    const { data: itv } = await supabase.from('interviews').select('role_target, mode').eq('id', data.interviewId).eq('user_id', context.userId).maybeSingle();
    if (!itv) throw new Error("Interview not found");

    const result = await groqJson<any>({
      system: `Synthesize the full ${itv.mode} interview for a ${itv.role_target} role. Return JSON:
{
  "overall_score": number,
  "communication": number,
  "technical": number,
  "confidence": number,
  "clarity": number,
  "problem_solving": number,
  "leadership": number,
  "behavioral": number,
  "culture_fit": number,
  "readiness": number,
  "star": number,
  "summary": "3-4 sentences on how the candidate performed",
  "strengths": [4-6 specific strings],
  "improvements": [4-6 specific strings],
  "most_impressive_answer": { "idx": number, "why": "string" },
  "weakest_answer": { "idx": number, "why": "string" },
  "recommended_learning": [strings — specific topics],
  "recommended_projects": [strings — concrete project ideas],
  "suggested_certifications": [strings],
  "practice_areas": [strings]
}
All scores 0-100. Every insight must reference the actual answers.`,
      user: `Turns:\n${JSON.stringify(turns).slice(0, 15000)}`,
    });

    await supabase.from('interview_results').upsert({
      id: uuidv4(), 
      interview_id: data.interviewId,
      overall_score: r(result.overall_score), 
      communication: r(result.communication), 
      technical: r(result.technical), 
      star: r(result.star), 
      confidence: r(result.confidence), 
      clarity: r(result.clarity),
      summary: result.summary ?? "", 
      strengths: result.strengths ?? [], 
      improvements: result.improvements ?? [], 
      raw: result,
      problem_solving: r(result.problem_solving), 
      leadership: r(result.leadership), 
      behavioral: r(result.behavioral), 
      culture_fit: r(result.culture_fit), 
      readiness: r(result.readiness)
    }, { onConflict: 'interview_id' });

    await supabase.from('interviews').update({ status: 'complete', ended_at: new Date().toISOString() }).eq('id', data.interviewId);

    try {
      const weak = (result.improvements ?? []).slice(0, 4).join(" | ");
      const covered = turns.map((t: any) => (t.question ?? "").slice(0, 80)).join(" | ");
      const { data: prof } = await supabase.from('profiles').select('coach_memory').eq('user_id', context.userId).maybeSingle();
      const prev = prof?.coach_memory ?? "";
      const merged = (`WEAK: ${weak}\nCOVERED: ${covered}\n---\n${prev}`).slice(0, 4000);
      await supabase.from('profiles').update({ coach_memory: merged }).eq('user_id', context.userId);
    } catch (e) { console.warn("[coach memory update failed]", (e as Error).message); }

    return { ...result, interviewId: data.interviewId };
  });

function r(n: any) { return Math.round(Number(n ?? 0)) || 0; }
function focusList(a: string[]) { return a && a.length ? a.join(", ") : "(none)"; }

export const listMyInterviews = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { data: dataArr } = await supabase.from('interviews').select('id, role_target, mode, status, started_at, ended_at').eq('user_id', context.userId).order('started_at', { ascending: false });
    if (!dataArr) return [];
    
    return await Promise.all(dataArr.map(async (i) => {
      const { data: result } = await supabase.from('interview_results').select('overall_score, communication, technical, confidence, clarity, readiness, summary').eq('interview_id', i.id).maybeSingle();
      return { ...i, interview_results: result ? [result] : [] };
    }));
  });

export const getInterviewReport = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator((d: unknown) => z.object({ interviewId: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: itv } = await supabase.from('interviews').select('*').eq('id', data.interviewId).eq('user_id', context.userId).maybeSingle();
    if (!itv) return null;
    
    const { data: result } = await supabase.from('interview_results').select('*').eq('interview_id', data.interviewId).maybeSingle();
    const { data: turnsData } = await supabase.from('interview_turns').select('idx, question, answer_transcript, evaluation, difficulty').eq('interview_id', data.interviewId).order('idx', { ascending: true });
    
    const turns = turnsData || [];
    
    return {
      interview: itv,
      result: result ? {
        ...result,
        strengths: safeJson(result.strengths) ?? [],
        improvements: safeJson(result.improvements) ?? [],
        raw: safeJson(result.raw) ?? null,
      } : null,
      turns: turns.map(t => ({ ...t, evaluation: safeJson(t.evaluation) })),
    };
  });

function safeJson(s: any) { if (typeof s !== "string") return s; try { return JSON.parse(s); } catch { return null; } }
