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

Return ONLY valid JSON array:
[
  {
    "question": "Sample question...",
    "answer": "Personalized answer incorporating their background and skills...",
    "tips": [
      "Specific actionable tip 1",
      "Specific actionable tip 2", 
      "Specific actionable tip 3"
    ]
  }
]

Requirements:
- Include only ${QUESTION_CATEGORIES[category]} type questions
- Answers should be 2-4 sentences, natural and conversational
- Tips must be specific, actionable advice (not generic)
- Incorporate their skills, education, and interests where relevant
- Return valid JSON only, no extra text`;
}

// Timeout wrapper for AI generation
async function generateWithTimeout(model, prompt, timeoutMs = 25000) {
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

    // Fetch talent information
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
      log(`Fetched talent: ${talent.fullname}`);
    } catch (e) {
      return res.json({ success: false, error: 'Talent not found', statusCode: 404 }, 404);
    }

    // Fetch career path
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
        log(`Warning: Could not fetch career path: ${e.message}`);
      }
    }

    let questions;
    
    // Initialize Gemini 2.5 Flash model with optimized configuration
    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.5-flash", // Updated to Gemini 2.5 Flash
      generationConfig: { 
        maxOutputTokens: 2500, // Reduced from 3000 for faster generation
        temperature: 0.6, // Slightly reduced for more consistent output
        topK: 32, // Added for better performance
        topP: 0.9, // Added for better performance
        candidateCount: 1 // Ensure single response
      }
    });

    try {
      const prompt = getCategoryPrompt(category, talent, careerPath);
      log(`Starting AI generation for ${QUESTION_CATEGORIES[category]} questions`);
      
      // Use timeout wrapper to prevent function timeout
      const result = await generateWithTimeout(model, prompt, 25000); // 25 second timeout
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
        usedFallback: false // New field to track model usage
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