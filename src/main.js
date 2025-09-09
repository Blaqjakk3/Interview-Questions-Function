/*
  Interview Questions Function (Serverless)
  -----------------------------------------
  This serverless function generates tailored interview questions for a given talent profile and question category.
  - Fetches talent and career path info from Appwrite database.
  - Builds a strict prompt for Google Gemini AI to generate 10 concise, relevant questions (with sample answers and tips).
  - Cleans and parses the AI's JSON response, enforcing length and structure constraints.
  - Returns a JSON response with 10 formatted questions and metadata.
  - Includes robust error handling, retries, and logging for reliability.

  Main Steps:
    1. Parse and validate input (talentId, category).
    2. Fetch talent and career path from database.
    3. Build a strict prompt for the selected category.
    4. Call Gemini AI with retries and exponential backoff.
    5. Clean and parse the AI's JSON output.
    6. Validate, format, and return exactly 10 questions.
    7. Handle errors gracefully with detailed logs and status codes.
*/

import { Client, Databases, Query } from 'node-appwrite';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Initialize Appwrite client and Gemini AI client
const client = new Client();
const endpoint = process.env.APPWRITE_FUNCTION_ENDPOINT || 'https://cloud.appwrite.io/v1';

client
  .setEndpoint(endpoint)
  .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || '67d074d0001dadc04f94')
  .setKey(process.env.APPWRITE_FUNCTION_API_KEY);

const databases = new Databases(client);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const config = {
  databaseId: 'career4me',
  careerPathsCollectionId: 'careerPaths',
  talentsCollectionId: 'talents',
};

// Question categories mapping
const QUESTION_CATEGORIES = {
  'personal': 'Personal Background & Motivations',
  'career': 'Career Goals & Aspirations',
  'company': 'Company & Role Fit',
  'technical': 'Technical / Role-Specific Questions',
  'behavioral': 'Behavioral Questions (STAR format)',
  'problem-solving': 'Problem-Solving & Critical Thinking',
  'teamwork': 'Teamwork & Communication'
};

// Extracts and cleans JSON from AI response, handling common formatting issues
function extractAndCleanJSON(text) {
  try {
    console.log('Raw AI response:', text.substring(0, 200) + '...');
    let cleaned = text.trim();
    cleaned = cleaned.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        console.log('Direct parse successful');
        return JSON.stringify(parsed);
      }
    } catch (e) {
      console.log('Direct parse failed, attempting cleanup...');
    }
    const arrayStart = cleaned.indexOf('[');
    const arrayEnd = cleaned.lastIndexOf(']');
    if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
      cleaned = cleaned.substring(arrayStart, arrayEnd + 1);
      console.log('Extracted JSON array:', cleaned.substring(0, 100) + '...');
    } else {
      const objects = [];
      let currentPos = 0;
      while (currentPos < cleaned.length) {
        const objStart = cleaned.indexOf('{', currentPos);
        if (objStart === -1) break;
        let braceCount = 0;
        let objEnd = objStart;
        for (let i = objStart; i < cleaned.length; i++) {
          if (cleaned[i] === '{') braceCount++;
          if (cleaned[i] === '}') braceCount--;
          if (braceCount === 0) {
            objEnd = i;
            break;
          }
        }
        if (braceCount === 0) {
          const objStr = cleaned.substring(objStart, objEnd + 1);
          objects.push(objStr);
          currentPos = objEnd + 1;
        } else {
          break;
        }
      }
      if (objects.length > 0) {
        cleaned = '[' + objects.join(',') + ']';
        console.log('Reconstructed JSON array from objects');
      } else {
        throw new Error('No valid JSON objects found in response');
      }
    }
    cleaned = cleaned
      .replace(/,(\s*[}\]])/g, '$1')
      .replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":')
      .replace(/:\s*'([^']*)'/g, ': "$1"')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/"\s*:\s*"/g, '": "')
      .replace(/"\s*,\s*"/g, '", "')
      .trim();
    console.log('Cleaned JSON:', cleaned.substring(0, 200) + '...');
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) {
      throw new Error('Parsed JSON is not an array');
    }
    console.log(`Successfully parsed ${parsed.length} questions`);
    return JSON.stringify(parsed);
  } catch (error) {
    console.error('JSON extraction failed:', error.message);
    console.error('Problematic text length:', text.length);
    console.error('First 500 chars:', text.substring(0, 500));
    console.error('Last 500 chars:', text.substring(Math.max(0, text.length - 500)));
    throw error;
  }
}

// Builds a strict prompt for the AI based on category, talent, and career path
function getCategoryPrompt(category, talent, careerPath) {
  const careerStageDescription = {
    'Pathfinder': 'entry-level professional starting their career',
    'Trailblazer': 'mid-level professional advancing their career',
    'Horizon Changer': 'experienced professional transitioning careers'
  }[talent.careerStage] || 'professional';

  const careerPathTitle = careerPath ? careerPath.title : 'their chosen field';
  const skills = (talent.skills || []).slice(0, 3);
  const degrees = (talent.degrees || []).slice(0, 2);
  const interests = (talent.interests || []).slice(0, 2);

  const talentContext = [
    skills.length > 0 ? `Skills: ${skills.join(', ')}` : '',
    degrees.length > 0 ? `Education: ${degrees.join(', ')}` : '',
    interests.length > 0 ? `Interests: ${interests.join(', ')}` : ''
  ].filter(Boolean).join('. ');

  const categoryPrompts = {
    'personal': `Generate 10 concise personal background questions for ${talent.fullname}, ${careerStageDescription} in ${careerPathTitle}. Focus on motivation, strengths, challenges.`,
    'career': `Generate 10 concise career goals questions for ${talent.fullname}, ${careerStageDescription} in ${careerPathTitle}. Focus on plans, ambitions, choices.`,
    'company': `Generate 10 concise company/role fit questions for ${talent.fullname}, ${careerStageDescription} in ${careerPathTitle}. Focus on why this company/role.`,
    'technical': `Generate 10 concise technical questions for ${talent.fullname}, ${careerStageDescription} in ${careerPathTitle}. Focus on relevant skills and knowledge.`,
    'behavioral': `Generate 10 concise STAR format behavioral questions for ${talent.fullname}, ${careerStageDescription} in ${careerPathTitle}. Focus on past experiences.`,
    'problem-solving': `Generate 10 concise problem-solving questions for ${talent.fullname}, ${careerStageDescription} in ${careerPathTitle}. Focus on approach to challenges.`,
    'teamwork': `Generate 10 concise teamwork questions for ${talent.fullname}, ${careerStageDescription} in ${careerPathTitle}. Focus on collaboration and communication.`
  };

  return `${categoryPrompts[category]}

${talentContext ? `Profile: ${talentContext}` : ''}

CRITICAL LENGTH CONSTRAINTS:
- Questions: Maximum 15 words each
- Sample answers: Maximum 40 words each (2-3 sentences)
- Tips: Maximum 8 words per tip

CRITICAL INSTRUCTIONS:
1. You MUST return ONLY a valid JSON array
2. NO additional text before or after the JSON
3. NO markdown formatting or code blocks
4. Use proper JSON syntax with double quotes only
5. Return exactly 10 question objects
6. Keep ALL content concise and impactful

Required JSON format:
[
  {
    "question": "Brief, direct question (max 15 words)?",
    "answer": "Concise sample answer for ${talent.fullname} (max 40 words). Professional and relevant to their background.",
    "tips": ["Tip 1 (max 8 words)", "Tip 2 (max 8 words)", "Tip 3 (max 8 words)"]
  }
]

REQUIREMENTS:
- Return EXACTLY 10 question objects
- Each question: relevant to ${QUESTION_CATEGORIES[category]}, max 15 words
- Each answer: sample response for ${talent.fullname}, max 40 words, tailored to ${careerStageDescription}
- Each tips array: exactly 3 actionable tips, max 8 words each
- Appropriate for ${careerStageDescription} level
- Use double quotes for all strings
- No trailing commas
- Start response immediately with [`;
}

// Calls Gemini AI with retries and exponential backoff
async function generateWithRetry(model, prompt, maxRetries = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`AI generation attempt ${attempt} of ${maxRetries}`);
      const result = await model.generateContent(prompt);
      if (!result || !result.response) {
        throw new Error('Empty response from AI model');
      }
      const responseText = result.response.text();
      if (!responseText || responseText.trim() === '') {
        throw new Error('Empty response text from AI model');
      }
      console.log(`AI response received (${responseText.length} characters)`);
      return responseText;
    } catch (err) {
      lastError = err;
      console.error(`Attempt ${attempt} failed:`, err.message);
      if (attempt === maxRetries) {
        console.error('All AI generation attempts failed');
        break;
      }
      const baseWaitTime = Math.pow(2, attempt) * 1000;
      const jitter = Math.random() * 1000;
      const waitTime = baseWaitTime + jitter;
      console.log(`Waiting ${Math.round(waitTime)}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
  throw lastError || new Error('AI generation failed after all retries');
}

// Main serverless function handler
export default async ({ req, res, log, error }) => {
  const startTime = Date.now();
  try {
    log('=== Interview Questions Function Started ===');
    let requestData;
    try {
      requestData = JSON.parse(req.body);
    } catch (e) {
      error('Invalid JSON input:', e.message);
      return res.json({ success: false, error: 'Invalid JSON input', statusCode: 400 }, 400);
    }
    const { talentId, category } = requestData;
    if (!talentId) {
      return res.json({ success: false, error: 'Missing talentId parameter', statusCode: 400 }, 400);
    }
    if (!category || !QUESTION_CATEGORIES[category]) {
      return res.json({ 
        success: false, 
        error: 'Invalid or missing category parameter', 
        validCategories: Object.keys(QUESTION_CATEGORIES),
        statusCode: 400 
      }, 400);
    }
    log(`Processing request for talentId: ${talentId}, category: ${category}`);
    // Fetch talent info
    let talent;
    try {
      const talentQuery = await databases.listDocuments(
        config.databaseId,
        config.talentsCollectionId,
        [Query.equal('talentId', talentId)]
      );
      if (talentQuery.documents.length === 0) {
        error('Talent not found for ID:', talentId);
        return res.json({ success: false, error: 'Talent not found', statusCode: 404 }, 404);
      }
      talent = talentQuery.documents[0];
      log(`Fetched talent: ${talent.fullname} (${talent.careerStage})`);
    } catch (e) {
      error('Database error fetching talent:', e.message);
      return res.json({ success: false, error: 'Database error: Could not fetch talent', statusCode: 500 }, 500);
    }
    // Fetch career path info
    let careerPath = null;
    if (talent.selectedPath) {
      try {
        careerPath = await databases.getDocument(
          config.databaseId,
          config.careerPathsCollectionId,
          talent.selectedPath
        );
        log(`Fetched career path: ${careerPath.title}`);
      } catch (e) {
        log(`Warning: Could not fetch career path (${e.message}). Continuing without career path info.`);
      }
    }
    // Initialize Gemini model
    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.0-flash",
    });
    const prompt = getCategoryPrompt(category, talent, careerPath);
    log(`Generated optimized prompt for ${QUESTION_CATEGORIES[category]} questions`);
    // Generate with retry
    const responseText = await generateWithRetry(model, prompt);
    log(`AI generation completed in ${Date.now() - startTime}ms`);
    // Parse JSON response
    const cleanedJson = extractAndCleanJSON(responseText);
    const parsedQuestions = JSON.parse(cleanedJson);
    if (!Array.isArray(parsedQuestions)) {
      throw new Error('Response is not an array');
    }
    log(`Successfully parsed ${parsedQuestions.length} questions`);
    // Validate and format questions
    const questions = parsedQuestions.slice(0, 10).map((q, index) => {
      if (!q.question || typeof q.question !== 'string') {
        throw new Error(`Invalid question at index ${index}: missing or invalid question field`);
      }
      if (!q.answer || typeof q.answer !== 'string') {
        throw new Error(`Invalid question at index ${index}: missing or invalid answer field`);
      }
      if (!Array.isArray(q.tips) || q.tips.length === 0) {
        throw new Error(`Invalid question at index ${index}: missing or invalid tips array`);
      }
      const question = q.question.trim();
      const answer = q.answer.trim();
      const tips = q.tips.slice(0, 3).map(tip => {
        const trimmedTip = typeof tip === 'string' ? tip.trim() : String(tip).trim();
        return trimmedTip.split(' ').length > 8 ? 
          trimmedTip.split(' ').slice(0, 8).join(' ') + '...' : 
          trimmedTip;
      });
      return {
        id: index + 1,
        question,
        answer,
        tips
      };
    });
    if (questions.length < 10) {
      throw new Error(`Generated only ${questions.length} questions, expected 10`);
    }
    const response = {
      success: true,
      statusCode: 200,
      questions: questions.slice(0, 10),
      metadata: {
        totalQuestions: 10,
        category: QUESTION_CATEGORIES[category],
        talent: {
          id: talent.$id,
          fullname: talent.fullname,
          careerStage: talent.careerStage
        },
        careerPath: careerPath ? {
          id: careerPath.$id,
          title: careerPath.title
        } : null,
        generatedAt: new Date().toISOString(),
        executionTime: Date.now() - startTime
      }
    };
    log(`Successfully generated ${questions.length} ${QUESTION_CATEGORIES[category]} questions in ${Date.now() - startTime}ms`);
    return res.json(response);
  } catch (err) {
    error(`Fatal error: ${err.message}`);
    error('Stack trace:', err.stack);
    return res.json({
      success: false,
      error: `Failed to generate interview questions: ${err.message}`,
      statusCode: 500,
      executionTime: Date.now() - startTime
    }, 500);
  }
};