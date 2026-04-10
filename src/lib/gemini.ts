import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY || '' });

export interface WordDetails {
  word: string;
  definition: string;
  usage: string;
  examples: string[];
  imagePrompt: string;
}

export async function getWordDetails(word: string): Promise<WordDetails> {
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `Provide details for the English word or phrase: "${word}". Include a clear definition, usage explanation, 3 example sentences, and a short, descriptive prompt for an AI image generator to create a simple, clear illustration of this word's meaning.`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          word: { type: Type.STRING },
          definition: { type: Type.STRING },
          usage: { type: Type.STRING },
          examples: {
            type: Type.ARRAY,
            items: { type: Type.STRING }
          },
          imagePrompt: { type: Type.STRING, description: "A visual description for an illustration." }
        },
        required: ["word", "definition", "usage", "examples", "imagePrompt"]
      }
    }
  });

  return JSON.parse(response.text);
}

export async function generateWordImage(prompt: string): Promise<string | null> {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: [
          {
            text: `A simple, clean, educational illustration for an English learning app. Subject: ${prompt}. Minimalist style, white background, soft colors.`,
          },
        ],
      },
    });

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        return `data:image/png;base64,${part.inlineData.data}`;
      }
    }
    return null;
  } catch (error) {
    console.error("Image generation failed:", error);
    return null;
  }
}

export async function transcribeAudio(audioBase64: string): Promise<string> {
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [
      { text: "Transcribe the following English audio into text. Return only the transcribed text, nothing else." },
      { inlineData: { data: audioBase64, mimeType: "audio/wav" } }
    ]
  });

  return response.text || "";
}

export async function getPronunciationFeedback(audioBase64: string, expectedText: string) {
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [
      { text: `Analyze the pronunciation of the following audio. The user was trying to say: "${expectedText}". Provide a score from 0-100 and specific feedback on how to improve.` },
      { inlineData: { data: audioBase64, mimeType: "audio/wav" } }
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          score: { type: Type.NUMBER },
          feedback: { type: Type.STRING }
        },
        required: ["score", "feedback"]
      }
    }
  });

  return JSON.parse(response.text);
}

export async function getRoleplayResponse(history: { role: string, parts: { text: string }[] }[], userMessage: string, scenario: string) {
  const chat = ai.chats.create({
    model: "gemini-3-flash-preview",
    config: {
      systemInstruction: `You are an English language tutor in a role-play scenario: "${scenario}". Respond naturally to the user, keep the conversation going, and occasionally correct their grammar if it's significantly wrong. Keep responses relatively short (1-3 sentences).`
    },
    history: history
  });

  const result = await chat.sendMessage({ message: userMessage });
  return result.text;
}
