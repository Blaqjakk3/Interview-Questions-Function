import { Client, Databases, Query } from 'node-appwrite';
import { GoogleGenerativeAI } from '@google/generative-ai';

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

const QUESTION_CATEGORIES = {
  'personal': 'Personal Background & Motivations',
  'career': 'Career Goals & Aspirations',
  'company': 'Company & Role Fit',
  'technical': 'Technical / Role-Specific Questions',
  'behavioral': 'Behavioral Questions (STAR format)',
  'problem-solving': 'Problem-Solving & Critical Thinking',
  'teamwork': 'Teamwork & Communication'
};

function extractAndCleanJSON(text) {
  try {
    let cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const startIndex = cleaned.indexOf('[');
    const lastIndex = cleaned.lastIndexOf(']');
    
    if (startIndex === -1 || lastIndex === -1 || startIndex >= lastIndex) {
      throw new Error('No valid JSON array found in response');
    }
    
    cleaned = cleaned.substring(startIndex, lastIndex + 1)
      .replace(/,(\s*[}\]])/g, '$1')
      .replace(/([{,]\s*)(\w+):/g, '$1"$2":')
      .replace(/:\s*'([^']*)'/g, ': "$1"')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    return cleaned;
  } catch (error) {
    throw new Error(`Failed to clean JSON: ${error.message}`);
  }
}

function getCategoryPrompt(category, talent, careerPath) {
  const careerStageDescription = {
    'Pathfinder': 'entry-level professional starting their career',
    'Trailblazer': 'mid-level professional advancing their career',
    'Horizon Changer': 'experienced professional transitioning careers'
  }[talent.careerStage] || 'professional';

  const careerPathTitle = careerPath ? careerPath.title : 'their chosen field';
  const skills = talent.skills || [];
  const degrees = talent.degrees || [];
  const interests = talent.interests || [];
  const certifications = talent.certifications || [];

  const talentContext = [
    skills.length > 0 ? `Skills: ${skills.join(', ')}` : '',
    degrees.length > 0 ? `Education: ${degrees.join(', ')}` : '',
    interests.length > 0 ? `Interests: ${interests.join(', ')}` : '',
    certifications.length > 0 ? `Certifications: ${certifications.join(', ')}` : ''
  ].filter(Boolean).join('. ');

  const categoryPrompts = {
    'personal': `Generate exactly 10 personal background and motivation questions for ${talent.fullname}, a ${careerStageDescription} interested in ${careerPathTitle}. Focus on questions about their personality, motivations, strengths, weaknesses, and how they handle challenges.`,
    'career': `Generate exactly 10 career goals and aspirations questions for ${talent.fullname}, a ${careerStageDescription} interested in ${careerPathTitle}. Focus on questions about their long-term plans, career choices, and professional ambitions.`,
    'company': `Generate exactly 10 company and role fit questions for ${talent.fullname}, a ${careerStageDescription} interested in ${careerPathTitle}. Focus on questions about why they want to work for specific companies and why they're interested in particular roles.`,
    'technical': `Generate exactly 10 technical/role-specific questions for ${talent.fullname}, a ${careerStageDescription} interested in ${careerPathTitle}. Focus on questions that test their knowledge and skills relevant to ${careerPathTitle}.`,
    'behavioral': `Generate exactly 10 behavioral questions (using STAR format) for ${talent.fullname}, a ${careerStageDescription} interested in ${careerPathTitle}. Focus on questions about past experiences that demonstrate their abilities.`,
    'problem-solving': `Generate exactly 10 problem-solving and critical thinking questions for ${talent.fullname}, a ${careerStageDescription} interested in ${careerPathTitle}. Focus on questions that test how they approach challenges and think through problems.`,
    'teamwork': `Generate exactly 10 teamwork and communication questions for ${talent.fullname}, a ${careerStageDescription} interested in ${careerPathTitle}. Focus on questions about collaboration, communication, and working with others.`
  };

  return `${categoryPrompts[category]}

${talentContext ? `Talent Profile: ${talentContext}` : ''}

IMPORTANT: Return ONLY valid JSON array with exactly 10 questions in this format:
[
  {
    "question": "...",
    "answer": "...",
    "tips": ["...", "...", "..."]
  }
]`;
}

// Enhanced AI generation with better error handling and retry logic
async function generateQuestionsWithRetry(category, talent, careerPath, maxRetries = 3) {
  const model = genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash",
    generationConfig: { 
      maxOutputTokens: 2000, 
      temperature: 0.6,
      topP: 0.85,
      topK: 30
    }
  });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const prompt = getCategoryPrompt(category, talent, careerPath);
      
      // Add timeout to the AI request
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('AI generation timeout')), 45000); // 45 second timeout
      });
      
      const generationPromise = model.generateContent(prompt);
      const result = await Promise.race([generationPromise, timeoutPromise]);
      
      const responseText = result.response.text();
      
      if (!responseText || responseText.trim().length === 0) {
        throw new Error('Empty response from AI');
      }
      
      const cleanedJson = extractAndCleanJSON(responseText);
      const parsedQuestions = JSON.parse(cleanedJson);
      
      if (!Array.isArray(parsedQuestions) || parsedQuestions.length === 0) {
        throw new Error('Invalid questions array from AI');
      }

      const questions = parsedQuestions.slice(0, 10).map((q, index) => {
        if (!q.question || !q.answer || !Array.isArray(q.tips)) {
          throw new Error(`Invalid question structure at index ${index}`);
        }
        return {
          id: index + 1,
          question: q.question.trim(),
          answer: q.answer.trim(),
          tips: q.tips.slice(0, 3).map(tip => tip.trim())
        };
      });

      return questions;

    } catch (error) {
      console.log(`AI generation attempt ${attempt} failed:`, error.message);
      
      if (attempt === maxRetries) {
        throw error;
      }
      
      // Exponential backoff with jitter
      const baseDelay = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
      const jitter = Math.random() * 1000;
      const delay = baseDelay + jitter;
      
      console.log(`Retrying in ${Math.round(delay)}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

export default async ({ req, res, log, error }) => {
  const startTime = Date.now();
  
  try {
    log('=== Interview Questions Function Started ===');
    
    // Early timeout check
    const FUNCTION_TIMEOUT = 90000; // 90 seconds
    const timeoutWarning = setTimeout(() => {
      log('WARNING: Function approaching timeout limit');
    }, FUNCTION_TIMEOUT - 10000);
    
    let requestData;
    try {
      requestData = JSON.parse(req.body);
    } catch (e) {
      clearTimeout(timeoutWarning);
      return res.json({ success: false, error: 'Invalid JSON input', statusCode: 400 }, 400);
    }

    const { talentId, category } = requestData;
    if (!talentId) {
      clearTimeout(timeoutWarning);
      return res.json({ success: false, error: 'Missing talentId parameter', statusCode: 400 }, 400);
    }

    if (!category || !QUESTION_CATEGORIES[category]) {
      clearTimeout(timeoutWarning);
      return res.json({ 
        success: false, 
        error: 'Invalid or missing category parameter', 
        validCategories: Object.keys(QUESTION_CATEGORIES),
        statusCode: 400 
      }, 400);
    }

    // Fetch talent information with timeout
    let talent;
    try {
      log('Fetching talent information...');
      const talentQuery = await databases.listDocuments(
        config.databaseId,
        config.talentsCollectionId,
        [Query.equal('talentId', talentId)]
      );

      if (talentQuery.documents.length === 0) {
        throw new Error('Talent not found');
      }

      talent = talentQuery.documents[0];
      log(`Fetched talent: ${talent.fullname}`);
    } catch (e) {
      clearTimeout(timeoutWarning);
      log(`Talent fetch error: ${e.message}`);
      return res.json({ success: false, error: 'Talent not found', statusCode: 404 }, 404);
    }

    // Fetch career path (optional, don't fail if not found)
    let careerPath = null;
    if (talent.selectedPath) {
      try {
        log('Fetching career path...');
        careerPath = await databases.getDocument(
          config.databaseId,
          config.careerPathsCollectionId,
          talent.selectedPath
        );
        log(`Fetched career path: ${careerPath.title}`);
      } catch (e) {
        log(`Warning: Could not fetch career path: ${e.message}`);
      }
    }

    // Check remaining time before AI generation
    const elapsedTime = Date.now() - startTime;
    const remainingTime = FUNCTION_TIMEOUT - elapsedTime;
    
    if (remainingTime < 30000) { // Less than 30 seconds remaining
      clearTimeout(timeoutWarning);
      log('Insufficient time remaining for AI generation');
      return res.json({ 
        success: false, 
        error: 'Function timeout risk - insufficient time for AI generation', 
        statusCode: 408 
      }, 408);
    }

    // Generate questions with enhanced error handling
    let questions;
    try {
      log('Starting AI generation...');
      questions = await generateQuestionsWithRetry(category, talent, careerPath);
      log(`Successfully generated ${questions.length} questions`);
    } catch (aiError) {
       clearTimeout(timeoutWarning);
       error(`AI generation failed: ${aiError.message}`);
       error(`Full error: ${JSON.stringify(aiError, null, 2)}`);
      
      // Return more specific error based on the type of failure
      if (aiError.message.includes('timeout')) {
        return res.json({ 
          success: false, 
          error: 'AI generation timeout - please try again',
           
          statusCode: 408 
        }, 408);
      } else if (aiError.message.includes('quota') || aiError.message.includes('rate limit')) {
        return res.json({ 
          success: false, 
          error: 'AI service temporarily unavailable - please try again later', 
          statusCode: 503 
        }, 503);
      } else {
        return res.json({ 
          success: false, 
          error: 'Failed to generate questions - please try again', 
          statusCode: 500 
        }, 500);
      }
    }

    clearTimeout(timeoutWarning);

    const response = {
      success: true,
      statusCode: 200,
      questions: questions,
      metadata: {
        totalQuestions: questions.length,
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
    error(`Unexpected Error: ${err.message}`);
    return res.json({
      success: false,
      error: 'Internal server error',
      statusCode: 500,
      executionTime: Date.now() - startTime
    }, 500);
  }
};