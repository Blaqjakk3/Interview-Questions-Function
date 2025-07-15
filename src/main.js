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
      if (Array.isArray(parsed)) return text;
    } catch (e) {
      // If direct parse fails, try cleaning
    }

    // Remove markdown code blocks and extra whitespace
    let cleaned = text
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .replace(/^\s*json\s*/i, '')
      .trim();
    
    // Try to find JSON array boundaries
    let startIndex = cleaned.indexOf('[');
    let lastIndex = cleaned.lastIndexOf(']');
    
    if (startIndex === -1 || lastIndex === -1) {
      // If no array found, look for objects and wrap in array
      const objectStart = cleaned.indexOf('{');
      const objectEnd = cleaned.lastIndexOf('}');
      
      if (objectStart !== -1 && objectEnd !== -1) {
        cleaned = `[${cleaned.substring(objectStart, objectEnd + 1)}]`;
        startIndex = 0;
        lastIndex = cleaned.length - 1;
      } else {
        throw new Error('No valid JSON structure found in response');
      }
    }
    
    if (startIndex >= lastIndex) {
      throw new Error('Invalid JSON array structure');
    }
    
    // Extract the JSON array
    cleaned = cleaned.substring(startIndex, lastIndex + 1);
    
    // More aggressive JSON cleaning
    cleaned = cleaned
      // Remove comments
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      // Fix common formatting issues
      .replace(/,(\s*[}\]])/g, '$1') // Remove trailing commas
      .replace(/([{,]\s*)(\w+):/g, '$1"$2":') // Quote unquoted keys
      .replace(/:\s*'([^']*)'/g, ': "$1"') // Convert single quotes to double quotes
      .replace(/:\s*`([^`]*)`/g, ': "$1"') // Convert backticks to double quotes
      // Fix escaped quotes within strings
      .replace(/\\"/g, '\\"')
      // Remove extra whitespace and newlines
      .replace(/\n/g, ' ')
      .replace(/\r/g, ' ')
      .replace(/\t/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    // Try to fix specific JSON issues
    cleaned = fixCommonJSONIssues(cleaned);
    
    // Try to parse the cleaned JSON
    const parsed = JSON.parse(cleaned);
    
    // Validate it's an array
    if (!Array.isArray(parsed)) {
      throw new Error('Parsed JSON is not an array');
    }
    
    return JSON.stringify(parsed);
    
  } catch (error) {
    console.error('JSON extraction failed:', error.message);
    console.error('Problematic text:', text.substring(0, 500) + '...');
    throw new Error(`Failed to clean JSON: ${error.message}`);
  }
}

function fixCommonJSONIssues(jsonString) {
  try {
    // Fix unescaped quotes in string values
    jsonString = jsonString.replace(/"([^"]*)"(\s*:\s*)"([^"]*(?:[^"\\]|\\.)*?)"/g, (match, key, colon, value) => {
      // Properly escape quotes within the value
      const escapedValue = value.replace(/(?<!\\)"/g, '\\"');
      return `"${key}"${colon}"${escapedValue}"`;
    });
    
    // Fix array formatting issues
    jsonString = jsonString.replace(/\[\s*,/g, '[');
    jsonString = jsonString.replace(/,\s*\]/g, ']');
    
    // Fix object formatting issues
    jsonString = jsonString.replace(/\{\s*,/g, '{');
    jsonString = jsonString.replace(/,\s*\}/g, '}');
    
    // Fix multiple consecutive commas
    jsonString = jsonString.replace(/,+/g, ',');
    
    // Fix missing commas between array elements
    jsonString = jsonString.replace(/\}\s*\{/g, '},{');
    
    return jsonString;
  } catch (error) {
    console.error('Error fixing JSON issues:', error);
    return jsonString;
  }
}

function getCategoryPrompt(category, talent, careerPath) {
  const careerStageDescription = {
    'Pathfinder': 'entry-level professional starting their career',
    'Trailblazer': 'mid-level professional advancing their career',
    'Horizon Changer': 'experienced professional transitioning careers'
  }[talent.careerStage] || 'professional';

  const careerPathTitle = careerPath ? careerPath.title : 'their chosen field';
  
  // Optimize talent context
  const skills = (talent.skills || []).slice(0, 5);
  const degrees = (talent.degrees || []).slice(0, 2);
  const interests = (talent.interests || []).slice(0, 3);

  const talentContext = [
    skills.length > 0 ? `Skills: ${skills.join(', ')}` : '',
    degrees.length > 0 ? `Education: ${degrees.join(', ')}` : '',
    interests.length > 0 ? `Interests: ${interests.join(', ')}` : ''
  ].filter(Boolean).join('. ');

  const categoryPrompts = {
    'personal': `Generate exactly 10 personal background questions for ${talent.fullname}, ${careerStageDescription} in ${careerPathTitle}. Focus on motivation, strengths, challenges.`,
    'career': `Generate exactly 10 career goals questions for ${talent.fullname}, ${careerStageDescription} in ${careerPathTitle}. Focus on plans, ambitions, choices.`,
    'company': `Generate exactly 10 company/role fit questions for ${talent.fullname}, ${careerStageDescription} in ${careerPathTitle}. Focus on why this company/role.`,
    'technical': `Generate exactly 10 technical questions for ${talent.fullname}, ${careerStageDescription} in ${careerPathTitle}. Focus on relevant skills and knowledge.`,
    'behavioral': `Generate exactly 10 STAR format behavioral questions for ${talent.fullname}, ${careerStageDescription} in ${careerPathTitle}. Focus on past experiences.`,
    'problem-solving': `Generate exactly 10 problem-solving questions for ${talent.fullname}, ${careerStageDescription} in ${careerPathTitle}. Focus on approach to challenges.`,
    'teamwork': `Generate exactly 10 teamwork questions for ${talent.fullname}, ${careerStageDescription} in ${careerPathTitle}. Focus on collaboration and communication.`
  };

  return `${categoryPrompts[category]}

${talentContext ? `Profile: ${talentContext}` : ''}

CRITICAL INSTRUCTIONS FOR JSON OUTPUT:
- Return ONLY a valid JSON array with NO additional text
- Use ONLY double quotes for all strings
- Do NOT use single quotes or backticks
- Do NOT include any markdown formatting or code blocks
- Do NOT include any explanatory text before or after the JSON
- Ensure all strings are properly escaped
- Use proper comma placement (no trailing commas)

Required JSON format (return exactly this structure):
[
  {
    "question": "Your first question here?",
    "answer": "Brief 2-3 sentence answer explaining how to approach this question.",
    "tips": ["Specific tip 1", "Specific tip 2", "Specific tip 3"]
  },
  {
    "question": "Your second question here?",
    "answer": "Brief 2-3 sentence answer explaining how to approach this question.",
    "tips": ["Specific tip 1", "Specific tip 2", "Specific tip 3"]
  }
]

REQUIREMENTS:
- Return EXACTLY 10 question objects
- Each question must be relevant to ${QUESTION_CATEGORIES[category]}
- Each answer must be 2-3 sentences maximum
- Each tips array must contain exactly 3 actionable tips
- All quotes within strings must be properly escaped with backslashes
- No trailing commas anywhere in the JSON
- Start response immediately with [ and end with ]`;
}

async function generateWithRetry(model, prompt, maxRetries = 3) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      
      if (!result || !result.response) {
        throw new Error('Empty response from AI model');
      }
      
      const responseText = result.response.text();
      if (!responseText || responseText.trim() === '') {
        throw new Error('Empty response text from AI model');
      }
      
      return responseText;
      
    } catch (err) {
      lastError = err;
      console.error(`Generation attempt ${attempt} failed:`, err.message);
      
      if (attempt === maxRetries) break;
      
      // Exponential backoff
      const waitTime = Math.pow(2, attempt) * 1000;
      console.log(`Waiting ${waitTime}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
  
  throw lastError || new Error('AI generation failed after retries');
}

function validateQuestionStructure(questions) {
  if (!Array.isArray(questions)) {
    throw new Error('Questions must be an array');
  }
  
  if (questions.length === 0) {
    throw new Error('Questions array cannot be empty');
  }
  
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    
    if (!q || typeof q !== 'object') {
      throw new Error(`Question at index ${i} is not an object`);
    }
    
    if (!q.question || typeof q.question !== 'string' || q.question.trim() === '') {
      throw new Error(`Question at index ${i} has invalid question field`);
    }
    
    if (!q.answer || typeof q.answer !== 'string' || q.answer.trim() === '') {
      throw new Error(`Question at index ${i} has invalid answer field`);
    }
    
    if (!Array.isArray(q.tips)) {
      throw new Error(`Question at index ${i} has invalid tips field (must be array)`);
    }
    
    if (q.tips.length === 0) {
      throw new Error(`Question at index ${i} has empty tips array`);
    }
    
    for (let j = 0; j < q.tips.length; j++) {
      if (!q.tips[j] || typeof q.tips[j] !== 'string' || q.tips[j].trim() === '') {
        throw new Error(`Question at index ${i}, tip at index ${j} is invalid`);
      }
    }
  }
  
  return true;
}

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
      error('Error fetching talent:', e.message);
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
        log(`Fetched career path: ${careerPath?.title || 'None'}`);
      } catch (e) {
        log(`Warning: Could not fetch career path: ${e.message}`);
      }
    }

    // Initialize Gemini 2.5 Flash model with optimized settings
    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.5-flash",
      generationConfig: { 
        maxOutputTokens: 3000,
        temperature: 0.2,
        topK: 20,
        topP: 0.8,
        candidateCount: 1
      }
    });

    const prompt = getCategoryPrompt(category, talent, careerPath);
    log(`Starting AI generation for ${QUESTION_CATEGORIES[category]} questions`);
    
    // Generate with retry mechanism
    const responseText = await generateWithRetry(model, prompt);
    log(`AI generation completed, response length: ${responseText.length}`);
    
    // Clean and parse JSON
    const cleanedJson = extractAndCleanJSON(responseText);
    const parsedQuestions = JSON.parse(cleanedJson);
    
    // Validate structure
    validateQuestionStructure(parsedQuestions);
    
    // Process and format questions
    const questions = parsedQuestions.slice(0, 10).map((q, index) => ({
      id: index + 1,
      question: q.question.trim(),
      answer: q.answer.trim(),
      tips: q.tips.slice(0, 3).map(tip => tip.trim())
    }));

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
    error(`Critical error: ${err.message}`);
    error(`Stack trace: ${err.stack}`);
    
    return res.json({
      success: false,
      error: `Failed to generate questions: ${err.message}`,
      statusCode: 500,
      executionTime: Date.now() - startTime,
      usedFallback: false
    }, 500);
  }
};