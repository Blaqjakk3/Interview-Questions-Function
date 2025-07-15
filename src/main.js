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

// Improved JSON extraction function with better error handling
function extractAndCleanJSON(text) {
  try {
    console.log('Raw AI response:', text.substring(0, 200) + '...');
    
    // Remove any leading/trailing whitespace
    let cleaned = text.trim();
    
    // Remove common markdown formatting
    cleaned = cleaned.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
    
    // Try direct parsing first
    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        console.log('Direct parse successful');
        return JSON.stringify(parsed);
      }
    } catch (e) {
      console.log('Direct parse failed, attempting cleanup...');
    }

    // Look for JSON array boundaries with more flexible approach
    const arrayStart = cleaned.indexOf('[');
    const arrayEnd = cleaned.lastIndexOf(']');
    
    if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
      // Extract the JSON array portion
      cleaned = cleaned.substring(arrayStart, arrayEnd + 1);
      console.log('Extracted JSON array:', cleaned.substring(0, 100) + '...');
    } else {
      // Try to find individual objects and wrap them in an array
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
    
    // Clean up common JSON formatting issues
    cleaned = cleaned
      .replace(/,(\s*[}\]])/g, '$1') // Remove trailing commas
      .replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":') // Quote unquoted keys
      .replace(/:\s*'([^']*)'/g, ': "$1"') // Convert single quotes to double quotes
      .replace(/\n/g, ' ') // Remove newlines
      .replace(/\s+/g, ' ') // Normalize whitespace
      .replace(/"\s*:\s*"/g, '": "') // Fix spacing around colons
      .replace(/"\s*,\s*"/g, '", "') // Fix spacing around commas
      .trim();
    
    console.log('Cleaned JSON:', cleaned.substring(0, 200) + '...');
    
    // Final parse attempt
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
    
    // Return a fallback response instead of throwing
    return createFallbackQuestions();
  }
}

// Create fallback questions when AI parsing fails
function createFallbackQuestions() {
  console.log('Creating fallback questions due to JSON parsing failure');
  
  const fallbackQuestions = [
    {
      "question": "Tell me about yourself and your background.",
      "answer": "Start with a brief overview of your professional background, highlighting key experiences and skills relevant to the role.",
      "tips": ["Keep it concise (2-3 minutes)", "Focus on relevant experiences", "End with why you're interested in this role"]
    },
    {
      "question": "What are your greatest strengths?",
      "answer": "Choose 2-3 strengths that are directly relevant to the job and provide specific examples.",
      "tips": ["Use concrete examples", "Connect to job requirements", "Avoid generic answers"]
    },
    {
      "question": "Where do you see yourself in 5 years?",
      "answer": "Show ambition while demonstrating commitment to growth within the company and field.",
      "tips": ["Align with company growth", "Show realistic progression", "Demonstrate long-term thinking"]
    },
    {
      "question": "Why are you interested in this role?",
      "answer": "Connect your skills and interests to the specific role and company mission.",
      "tips": ["Research the company", "Be specific about the role", "Show genuine enthusiasm"]
    },
    {
      "question": "Describe a challenging situation you overcame.",
      "answer": "Use the STAR method (Situation, Task, Action, Result) to structure your response.",
      "tips": ["Choose a relevant example", "Focus on your actions", "Highlight the positive outcome"]
    },
    {
      "question": "What motivates you in your work?",
      "answer": "Share what drives you professionally and how it aligns with the role.",
      "tips": ["Be authentic", "Connect to job duties", "Show passion for the field"]
    },
    {
      "question": "How do you handle stress and pressure?",
      "answer": "Provide concrete examples of stress management techniques you use.",
      "tips": ["Give specific strategies", "Show you can perform under pressure", "Mention time management skills"]
    },
    {
      "question": "What are your salary expectations?",
      "answer": "Research market rates and provide a range based on your experience and the role.",
      "tips": ["Research market rates", "Provide a reasonable range", "Be open to negotiation"]
    },
    {
      "question": "Do you have any questions for us?",
      "answer": "Always have thoughtful questions prepared about the role, team, and company.",
      "tips": ["Ask about growth opportunities", "Inquire about team dynamics", "Show interest in company culture"]
    },
    {
      "question": "Why should we hire you?",
      "answer": "Summarize your key qualifications and how they make you the ideal candidate.",
      "tips": ["Highlight unique value", "Reference specific requirements", "Show confidence without arrogance"]
    }
  ];
  
  return JSON.stringify(fallbackQuestions);
}

// Improved prompt with more specific formatting instructions
function getCategoryPrompt(category, talent, careerPath) {
  const careerStageDescription = {
    'Pathfinder': 'entry-level professional starting their career',
    'Trailblazer': 'mid-level professional advancing their career',
    'Horizon Changer': 'experienced professional transitioning careers'
  }[talent.careerStage] || 'professional';

  const careerPathTitle = careerPath ? careerPath.title : 'their chosen field';
  
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

CRITICAL INSTRUCTIONS:
1. You MUST return ONLY a valid JSON array
2. NO additional text before or after the JSON
3. NO markdown formatting or code blocks
4. Use proper JSON syntax with double quotes only
5. Return exactly 10 question objects

Required JSON format:
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
- Questions should be appropriate for ${careerStageDescription} level
- Use double quotes for all strings
- No trailing commas
- Start response immediately with the opening bracket [`;
}

// Enhanced retry mechanism with exponential backoff
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
      
      // Exponential backoff with jitter
      const baseWaitTime = Math.pow(2, attempt) * 1000;
      const jitter = Math.random() * 1000;
      const waitTime = baseWaitTime + jitter;
      
      console.log(`Waiting ${Math.round(waitTime)}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
  
  throw lastError || new Error('AI generation failed after all retries');
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

    log(`Processing request for talentId: ${talentId}, category: ${category}`);

    // Fetch talent information with better error handling
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

    // Fetch career path with better error handling
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

    // Initialize Gemini model with optimized settings
    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.5-flash",
      generationConfig: { 
        maxOutputTokens: 4000, // Increased for better JSON generation
        temperature: 0.1, // Lower temperature for more consistent JSON
        topK: 20,
        topP: 0.8,
        candidateCount: 1
      }
    });

    const prompt = getCategoryPrompt(category, talent, careerPath);
    log(`Generated prompt for ${QUESTION_CATEGORIES[category]} questions`);
    
    // Generate with retry mechanism
    let responseText;
    let usedFallback = false;
    
    try {
      responseText = await generateWithRetry(model, prompt);
      log(`AI generation completed in ${Date.now() - startTime}ms`);
    } catch (aiError) {
      error('AI generation failed completely:', aiError.message);
      log('Using fallback questions due to AI failure');
      responseText = createFallbackQuestions();
      usedFallback = true;
    }
    
    // Parse the JSON response
    let parsedQuestions;
    try {
      const cleanedJson = extractAndCleanJSON(responseText);
      parsedQuestions = JSON.parse(cleanedJson);
      
      if (!Array.isArray(parsedQuestions)) {
        throw new Error('Response is not an array');
      }
      
      log(`Successfully parsed ${parsedQuestions.length} questions`);
    } catch (parseError) {
      error('JSON parsing failed:', parseError.message);
      log('Using fallback questions due to parsing failure');
      const fallbackJson = createFallbackQuestions();
      parsedQuestions = JSON.parse(fallbackJson);
      usedFallback = true;
    }
    
    // Validate and format questions
    const questions = parsedQuestions.slice(0, 10).map((q, index) => {
      // Validate question structure
      if (!q.question || typeof q.question !== 'string') {
        throw new Error(`Invalid question at index ${index}: missing or invalid question field`);
      }
      
      if (!q.answer || typeof q.answer !== 'string') {
        throw new Error(`Invalid question at index ${index}: missing or invalid answer field`);
      }
      
      if (!Array.isArray(q.tips) || q.tips.length === 0) {
        throw new Error(`Invalid question at index ${index}: missing or invalid tips array`);
      }
      
      return {
        id: index + 1,
        question: q.question.trim(),
        answer: q.answer.trim(),
        tips: q.tips.slice(0, 3).map(tip => typeof tip === 'string' ? tip.trim() : String(tip).trim())
      };
    });

    // Ensure we have exactly 10 questions
    while (questions.length < 10) {
      const fallbackData = JSON.parse(createFallbackQuestions());
      const additionalQuestion = fallbackData[questions.length % fallbackData.length];
      questions.push({
        id: questions.length + 1,
        question: additionalQuestion.question,
        answer: additionalQuestion.answer,
        tips: additionalQuestion.tips
      });
    }

    const response = {
      success: true,
      statusCode: 200,
      questions: questions.slice(0, 10), // Ensure exactly 10 questions
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
        executionTime: Date.now() - startTime,
        usedFallback: usedFallback
      }
    };

    log(`Successfully generated ${questions.length} ${QUESTION_CATEGORIES[category]} questions in ${Date.now() - startTime}ms${usedFallback ? ' (using fallback)' : ''}`);
    return res.json(response);

  } catch (err) {
    error(`Fatal error: ${err.message}`);
    error('Stack trace:', err.stack);
    
    // Return fallback response even on fatal errors
    try {
      const fallbackQuestions = JSON.parse(createFallbackQuestions());
      const fallbackResponse = {
        success: true,
        statusCode: 200,
        questions: fallbackQuestions.slice(0, 10).map((q, index) => ({
          id: index + 1,
          question: q.question,
          answer: q.answer,
          tips: q.tips
        })),
        metadata: {
          totalQuestions: 10,
          category: QUESTION_CATEGORIES[requestData?.category] || 'General',
          talent: {
            id: 'unknown',
            fullname: 'Unknown',
            careerStage: 'Unknown'
          },
          careerPath: null,
          generatedAt: new Date().toISOString(),
          executionTime: Date.now() - startTime,
          usedFallback: true
        }
      };
      
      log('Returning fallback response due to fatal error');
      return res.json(fallbackResponse);
      
    } catch (fallbackError) {
      error('Even fallback failed:', fallbackError.message);
      return res.json({
        success: false,
        error: `Critical failure: ${err.message}`,
        statusCode: 500,
        executionTime: Date.now() - startTime
      }, 500);
    }
  }
};