import { GoogleGenAI, Modality, Type } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error("GEMINI_API_KEY is not set");
}
const ai = new GoogleGenAI({ apiKey });

export async function generateSpeech(text: string, voiceName: string = 'Kore', tone?: string, speed: number = 1.0) {
  let speedInstruction = "";
  if (speed < 0.8) speedInstruction = "very slowly";
  else if (speed < 1.0) speedInstruction = "slowly";
  else if (speed > 1.2) speedInstruction = "very fast";
  else if (speed > 1.0) speedInstruction = "fast";

  const prompt = `${speedInstruction ? `Say it ${speedInstruction}: ` : ""}${tone ? `Say it with a ${tone} tone: ` : ""}${text}`;
  
  const response = await ai.models.generateContent({
    model: "gemini-3.1-flash-tts-preview",
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
  });

  const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64Audio) {
    throw new Error("No audio data received from Gemini TTS");
  }

  // Convert base64 to Blob
  const binaryString = atob(base64Audio);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  
  return bytes;
}

export async function getSpeechFeedback(original: string, recognized: string) {
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `
You are an expert English speech coach.
Compare the student's recognized transcript with the original text.

Original: "${original}"
Transcript: "${recognized}"

Please analyze the speech and provide feedback in Japanese.
Additionally, extract difficult words or phrases that the student should practice repeatedly.
    `,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          score: { type: Type.NUMBER, description: "A score from 0-100" },
          feedback: { type: Type.STRING, description: "Detailed feedback in Japanese" },
          practiceItems: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                text: { type: Type.STRING, description: "The word or short phrase" },
                type: { type: Type.STRING, enum: ["word", "phrase"], description: "Whether it is a single word or a short phrase" },
                reason: { type: Type.STRING, description: "Why it was difficult or needs practice (in Japanese)" }
              },
              required: ["text", "type", "reason"]
            }
          }
        },
        required: ["score", "feedback", "practiceItems"]
      }
    }
  });

  try {
    const result = JSON.parse(response.text || "{}");
    return result;
  } catch (e) {
    return {
      score: 0,
      feedback: "Feedback parsing error.",
      practiceItems: []
    };
  }
}

export async function getLabItemScore(target: string, recognized: string) {
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `
You are a speech coach. Evaluate how accurately the student said the target text.
Target: "${target}"
Recognized: "${recognized}"
Provide a numeric score (0-100).
    `,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          score: { type: Type.NUMBER }
        },
        required: ["score"]
      }
    }
  });

  try {
    const result = JSON.parse(response.text || "{}");
    return result.score || 0;
  } catch (e) {
    return 0;
  }
}

export async function rewriteSpeechScript(text: string, style: 'business' | 'casual') {
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `
Rewrite the following English speech script to be more ${style === 'business' ? 'professional and suitable for a business environment' : 'natural and suitable for casual conversation'}.
Keep the core meaning the same but adjust the vocabulary and tone.
Script: "${text}"
Output only the rewritten script text.
    `,
  });

  return response.text?.trim() || text;
}
