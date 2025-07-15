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
  
  // Optimize talent context - only include most relevant info
  const skills = (talent.skills || []).slice(0, 5); // Limit to top 5 skills
  const degrees = (talent.degrees || []).slice(0, 2); // Limit to top 2 degrees
  const interests = (talent.interests || []).slice(0, 3); // Limit to top 3 interests

  const talentContext = [
    skills.length > 0 ? `Skills: ${skills.join(', ')}` : '',
    degrees.length > 0 ? `Education: ${degrees.join(', ')}` : '',
    interests.length > 0 ? `Interests: ${interests.join(', ')}` : ''
  ].filter(Boolean).join('. ');

  // Shortened, more focused prompts for faster generation
  const categoryPrompts = {
    'personal': `Generate 10 personal background questions for ${talent.fullname}, ${careerStageDescription} in ${careerPathTitle}. Focus on motivation, strengths, challenges.`,
    'career': `Generate 10 career goals questions for ${talent.fullname}, ${careerStageDescription} in ${careerPathTitle}. Focus on plans, ambitions, choices.`,
    'company': `Generate 10 company/role fit questions for ${talent.fullname}, ${careerStageDescription} in ${careerPathTitle}. Focus on why this company/role.`,
    'technical': `Generate 10 technical questions for ${talent.fullname}, ${careerStageDescription} in ${careerPathTitle}. Focus on relevant skills and knowledge.`,
    'behavioral': `Generate 10 STAR format behavioral questions for ${talent.fullname}, ${careerStageDescription} in ${careerPathTitle}. Focus on past experiences.`,
    'problem-solving': `Generate 10 problem-solving questions for ${talent.fullname}, ${careerStageDescription} in ${careerPathTitle}. Focus on approach to challenges.`,
    'teamwork': `Generate 10 teamwork questions for ${talent.fullname}, ${careerStageDescription} in ${careerPathTitle}. Focus on collaboration and communication.`
  };

  return `${categoryPrompts[category]}

${talentContext ? `Profile: ${talentContext}` : ''}

Return ONLY this JSON format:
[
  {
    "question": "Question text",
    "answer": "Brief 2-3 sentence answer",
    "tips": ["Tip 1", "Tip 2", "Tip 3"]
  }
]

Requirements:
- Exactly 10 questions for ${QUESTION_CATEGORIES[category]}
- Answers: 2-3 sentences, natural tone
- Tips: 3 specific, actionable tips each
- Valid JSON only, no extra text`;
}

// Aggressive timeout wrapper - must complete before Appwrite timeout
async function generateWithTimeout(model, prompt, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('AI generation timeout'));
    }, timeoutMs);

    model.generateContent(prompt)
      .then(result => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch(err => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

export default async ({ req, res, log, error }) => {
  const startTime = Date.now();
  
  try {
    log('=== Interview Questions Function Started ===');
    
    let requestData;
    try {
      requestData = JSON.parse(req.body);
    } catch (e) {
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

    // Fetch talent information with timeout check
    let talent;
    try {
      const talentQuery = await databases.listDocuments(
        config.databaseId,
        config.talentsCollectionId,
        [Query.equal('talentId', talentId)]
      );

      if (talentQuery.documents.length === 0) {
        throw new Error('Talent not found');
      }

      talent = talentQuery.documents[0];
      log(`Fetched talent: ${talent.fullname} (${Date.now() - startTime}ms)`);
    } catch (e) {
      return res.json({ success: false, error: 'Talent not found', statusCode: 404 }, 404);
    }

    // Quick timeout check - abort if we're already past 3 seconds
    if (Date.now() - startTime > 3000) {
      return res.json({ 
        success: false, 
        error: 'Function timeout - database queries took too long', 
        statusCode: 408 
      }, 408);
    }

    // Fetch career path (with minimal timeout)
    let careerPath = null;
    if (talent.selectedPath) {
      try {
        careerPath = await databases.getDocument(
          config.databaseId,
          config.careerPathsCollectionId,
          talent.selectedPath
        );
        log(`Fetched career path: ${careerPath.title} (${Date.now() - startTime}ms)`);
      } catch (e) {
        log(`Warning: Could not fetch career path: ${e.message}`);
      }
    }

    let questions;
    
    // Initialize Gemini 2.5 Flash model with MAXIMUM performance settings
    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.5-flash",
      generationConfig: { 
        maxOutputTokens: 1500, // Reduced significantly for faster generation
        temperature: 0.4, // Lower for more predictable output
        topK: 20, // Reduced for faster processing
        topP: 0.8, // Reduced for faster processing
        candidateCount: 1,
        stopSequences: ["\n\n\n"] // Help stop generation early
      }
    });

    try {
      const prompt = getCategoryPrompt(category, talent, careerPath);
      log(`Starting AI generation for ${QUESTION_CATEGORIES[category]} questions (${Date.now() - startTime}ms)`);
      
      // Critical: Only 12 seconds for AI generation (function has ~15s total)
      const result = await generateWithTimeout(model, prompt, 12000);
      const responseText = result.response.text();
      
      log(`AI generation completed in ${Date.now() - startTime}ms`);
      
      const cleanedJson = extractAndCleanJSON(responseText);
      const parsedQuestions = JSON.parse(cleanedJson);
      
      if (!Array.isArray(parsedQuestions) || parsedQuestions.length === 0) {
        throw new Error('Invalid questions array from AI');
      }

      questions = parsedQuestions.slice(0, 10).map((q, index) => {
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

      log(`Successfully processed ${questions.length} ${QUESTION_CATEGORIES[category]} questions with tips`);

    } catch (aiError) {
      error(`AI generation failed: ${aiError.message}`);
      
      // Check if it's a timeout error
      if (aiError.message.includes('timeout')) {
        return res.json({ 
          success: false, 
          error: 'Request timeout - please try again', 
          statusCode: 408 
        }, 408);
      }
      
      return res.json({ 
        success: false, 
        error: 'Failed to generate questions', 
        statusCode: 500 
      }, 500);
    }

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
        executionTime: Date.now() - startTime,
        usedFallback: false
      }
    };

    log(`Generated ${questions.length} ${QUESTION_CATEGORIES[category]} questions in ${Date.now() - startTime}ms`);
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