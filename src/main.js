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
    // First attempt to parse directly
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return JSON.stringify(parsed);
      }
    } catch (e) {
      // If direct parse fails, try cleaning
    }

    // Remove markdown code blocks and extra whitespace
    let cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    
    // Try to find JSON boundaries
    let startIndex = Math.max(cleaned.indexOf('['), cleaned.indexOf('{'));
    let lastIndex = Math.max(cleaned.lastIndexOf(']'), cleaned.lastIndexOf('}'));
    
    if (startIndex === -1 || lastIndex === -1 || startIndex >= lastIndex) {
      throw new Error('No valid JSON structure found in response');
    }
    
    // Extract the JSON portion
    cleaned = cleaned.substring(startIndex, lastIndex + 1);
    
    // Clean up common JSON formatting issues
    cleaned = cleaned
      .replace(/,(\s*[}\]])/g, '$1') // Remove trailing commas
      .replace(/([{,]\s*)(\w+):/g, '$1"$2":') // Quote unquoted keys
      .replace(/:\s*'([^']*)'/g, ': "$1"') // Convert single quotes to double quotes
      .replace(/\n/g, ' ') // Remove newlines
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
    
    // Try to parse the cleaned JSON
    const parsed = JSON.parse(cleaned);
    
    // If we got an object, wrap it in an array
    if (parsed && !Array.isArray(parsed)) {
      return JSON.stringify([parsed]);
    }
    
    return JSON.stringify(parsed);
    
  } catch (error) {
    console.error('JSON extraction failed:', error.message);
    throw new Error(`Failed to clean JSON: ${error.message}`);
  }
}

function getEnhancedPrompt(category, talent, careerPath) {
  const careerStageDescription = {
    'Pathfinder': 'entry-level professional starting their career',
    'Trailblazer': 'mid-level professional advancing their career',
    'Horizon Changer': 'experienced professional transitioning careers'
  }[talent.careerStage] || 'professional';

  const careerPathTitle = careerPath ? careerPath.title : 'their chosen field';
  
  // Enhanced talent context
  const skills = (talent.skills || []).slice(0, 5).join(', ');
  const degrees = (talent.degrees || []).slice(0, 2).join(', ');
  const interests = (talent.interests || []).slice(0, 3).join(', ');
  const experience = talent.yearsOfExperience ? `${talent.yearsOfExperience} years of experience` : '';

  const categorySpecificPrompts = {
    'personal': `Generate exactly 10 insightful personal background questions for ${talent.fullname}, a ${careerStageDescription} in ${careerPathTitle}. Focus on unique aspects of their background, motivations, and personal strengths that would be relevant for interviews in this field.`,
    'career': `Generate exactly 10 strategic career development questions for ${talent.fullname}, a ${careerStageDescription} in ${careerPathTitle}. Focus on career trajectory, professional growth, and alignment with industry trends.`,
    'company': `Generate exactly 10 targeted company/role fit questions for ${talent.fullname}, a ${careerStageDescription} in ${careerPathTitle}. Focus on specific company values, culture fit, and role-specific competencies.`,
    'technical': `Generate exactly 10 technical depth questions for ${talent.fullname}, a ${careerStageDescription} in ${careerPathTitle}. Focus on current technologies, problem-solving approaches, and technical decision-making.`,
    'behavioral': `Generate exactly 10 behavioral competency questions for ${talent.fullname}, a ${careerStageDescription} in ${careerPathTitle}. Use the STAR format and focus on measurable outcomes and learning experiences.`,
    'problem-solving': `Generate exactly 10 complex problem-solving questions for ${talent.fullname}, a ${careerStageDescription} in ${careerPathTitle}. Focus on analytical approaches, creative solutions, and results-oriented thinking.`,
    'teamwork': `Generate exactly 10 collaboration-focused questions for ${talent.fullname}, a ${careerStageDescription} in ${careerPathTitle}. Focus on team dynamics, conflict resolution, and collective achievement.`
  };

  return `You are an expert career coach specializing in ${careerPathTitle}. Create interview questions that will help ${talent.fullname} excel in their job search.

Context:
- Career Stage: ${careerStageDescription}
- Skills: ${skills || 'Not specified'}
- Education: ${degrees || 'Not specified'}
- Interests: ${interests || 'Not specified'}
- Experience: ${experience || 'Not specified'}

Task:
${categorySpecificPrompts[category]}

Output Requirements:
- Return ONLY a valid JSON array of exactly 10 question objects
- Each object must have:
  - "question": A specific, tailored interview question
  - "answer": A 2-3 sentence professional response guideline
  - "tips": An array of exactly 3 actionable, specific tips
- Format:
  [
    {
      "question": "Tailored question here?",
      "answer": "Professional response guidance here.",
      "tips": ["Specific tip 1", "Specific tip 2", "Specific tip 3"]
    },
    ...
  ]

Important:
- Questions must be highly relevant to ${QUESTION_CATEGORIES[category]}
- Avoid generic questions - personalize based on the context
- Ensure technical accuracy for the field
- Maintain professional tone throughout`;
}

async function generateQuestionsWithRetry(model, prompt, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      
      // Validate we got some response
      if (!responseText || responseText.trim() === '') {
        throw new Error('Empty response from AI model');
      }
      
      // Try to extract JSON
      const cleanedJson = extractAndCleanJSON(responseText);
      const parsedQuestions = JSON.parse(cleanedJson);
      
      // Validate structure
      if (!Array.isArray(parsedQuestions) || parsedQuestions.length !== 10) {
        throw new Error(`Expected 10 questions, got ${parsedQuestions.length}`);
      }
      
      // Validate each question
      const validatedQuestions = parsedQuestions.map((q, index) => {
        if (!q.question || typeof q.question !== 'string') {
          throw new Error(`Missing or invalid question at index ${index}`);
        }
        if (!q.answer || typeof q.answer !== 'string') {
          throw new Error(`Missing or invalid answer at index ${index}`);
        }
        if (!Array.isArray(q.tips) || q.tips.length !== 3) {
          throw new Error(`Tips must be an array of exactly 3 items at index ${index}`);
        }
        return {
          id: index + 1,
          question: q.question.trim(),
          answer: q.answer.trim(),
          tips: q.tips.map(tip => tip.toString().trim())
        };
      });
      
      return validatedQuestions;
      
    } catch (error) {
      lastError = error;
      console.error(`Attempt ${attempt} failed:`, error.message);
      
      if (attempt === maxRetries) break;
      
      // Exponential backoff with longer delays for free tier
      const waitTime = Math.pow(2, attempt) * 2000; // Increased wait time
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
  
  throw new Error(`Failed after ${maxRetries} attempts. Last error: ${lastError.message}`);
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
        log(`Note: No career path found for talent`);
      }
    }

    // Initialize Gemini model - using 2.0 Flash for free tier
    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.0-flash-exp",
      generationConfig: { 
        maxOutputTokens: 3000, // Reduced for free tier
        temperature: 0.7,
        topK: 40,
        topP: 0.9,
        candidateCount: 1
      },
      safetySettings: [
        {
          category: "HARM_CATEGORY_HARASSMENT",
          threshold: "BLOCK_MEDIUM_AND_ABOVE"
        },
        {
          category: "HARM_CATEGORY_HATE_SPEECH",
          threshold: "BLOCK_MEDIUM_AND_ABOVE"
        },
        {
          category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
          threshold: "BLOCK_MEDIUM_AND_ABOVE"
        },
        {
          category: "HARM_CATEGORY_DANGEROUS_CONTENT",
          threshold: "BLOCK_MEDIUM_AND_ABOVE"
        }
      ]
    });

    const prompt = getEnhancedPrompt(category, talent, careerPath);
    log(`Starting AI generation for ${QUESTION_CATEGORIES[category]} questions using Gemini 2.0 Flash`);
    
    // Generate with retry mechanism
    const questions = await generateQuestionsWithRetry(model, prompt);
    
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
        usedFallback: false,
        modelUsed: "gemini-2.0-flash-exp"
      }
    };

    log(`Successfully generated ${questions.length} ${QUESTION_CATEGORIES[category]} questions in ${Date.now() - startTime}ms`);
    return res.json(response);

  } catch (err) {
    error(`Unexpected Error: ${err.message}`);
    return res.json({
      success: false,
      error: 'Failed to generate questions: ' + err.message,
      statusCode: 500,
      executionTime: Date.now() - startTime
    }, 500);
  }
};