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
    // First, let's log what we're getting from the AI
    console.log('Raw AI Response:', text.substring(0, 500) + '...');
    
    // Remove markdown code blocks and extra whitespace
    let cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    
    // Try to find JSON array boundaries more flexibly
    let startIndex = cleaned.indexOf('[');
    let lastIndex = cleaned.lastIndexOf(']');
    
    // If we can't find array brackets, try to find object brackets and wrap in array
    if (startIndex === -1 || lastIndex === -1) {
      console.log('No array brackets found, looking for objects...');
      
      // Look for objects that start with { and end with }
      const objectStart = cleaned.indexOf('{');
      const objectEnd = cleaned.lastIndexOf('}');
      
      if (objectStart !== -1 && objectEnd !== -1) {
        // Extract the content between braces
        const objectContent = cleaned.substring(objectStart, objectEnd + 1);
        
        // Try to parse as a single object first
        try {
          const singleObject = JSON.parse(objectContent);
          // If it's a valid object, wrap it in an array
          return JSON.stringify([singleObject]);
        } catch (e) {
          console.log('Single object parsing failed, trying to find multiple objects');
          
          // Try to find multiple objects and wrap them in an array
          const objectPattern = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
          const objects = objectContent.match(objectPattern);
          
          if (objects && objects.length > 0) {
            try {
              const parsedObjects = objects.map(obj => JSON.parse(obj));
              return JSON.stringify(parsedObjects);
            } catch (parseError) {
              console.log('Multiple objects parsing failed:', parseError);
            }
          }
        }
      }
      
      throw new Error('No valid JSON structure found in response');
    }
    
    if (startIndex >= lastIndex) {
      throw new Error('Invalid JSON array structure');
    }
    
    // Extract the JSON array
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
    
    // Validate it's an array
    if (!Array.isArray(parsed)) {
      throw new Error('Parsed JSON is not an array');
    }
    
    console.log(`Successfully parsed JSON array with ${parsed.length} items`);
    return JSON.stringify(parsed);
    
  } catch (error) {
    console.error('JSON extraction failed:', error.message);
    console.error('Problematic text:', text.substring(0, 1000));
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

CRITICAL: You must return ONLY a valid JSON array in this exact format:

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
- Return ONLY the JSON array, no additional text before or after
- Use proper JSON formatting with double quotes
- Do not include any markdown formatting or code blocks`;
}

// Enhanced timeout wrapper with better error handling
async function generateWithTimeout(model, prompt, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('AI generation timeout - request took too long'));
    }, timeoutMs);

    model.generateContent(prompt)
      .then(result => {
        clearTimeout(timer);
        
        if (!result || !result.response) {
          reject(new Error('Empty response from AI model'));
          return;
        }
        
        const responseText = result.response.text();
        if (!responseText || responseText.trim() === '') {
          reject(new Error('Empty response text from AI model'));
          return;
        }
        
        resolve(result);
      })
      .catch(err => {
        clearTimeout(timer);
        console.error('AI generation error:', err);
        reject(new Error(`AI generation failed: ${err.message}`));
      });
  });
}

// Fallback questions generator for when AI fails
function generateFallbackQuestions(category, talent, careerPath) {
  const careerPathTitle = careerPath ? careerPath.title : 'your chosen field';
  
  const fallbackQuestions = {
    'personal': [
      {
        question: "Tell me about yourself and what motivates you in your career.",
        answer: "Structure your response around your current situation, relevant experiences, and career goals. Focus on what drives your passion for this field.",
        tips: ["Keep it concise and professional", "Connect your background to the role", "Show enthusiasm for your field"]
      },
      {
        question: "What are your greatest strengths and how do they apply to this role?",
        answer: "Choose 2-3 key strengths that directly relate to the position. Provide specific examples of how you've demonstrated these strengths.",
        tips: ["Use concrete examples", "Relate strengths to job requirements", "Avoid generic answers"]
      },
      {
        question: "What is your biggest weakness and how are you working to improve it?",
        answer: "Choose a real weakness that won't disqualify you. Explain the steps you're taking to address it and show self-awareness.",
        tips: ["Be authentic but strategic", "Show improvement efforts", "Don't say you have no weaknesses"]
      }
    ],
    'career': [
      {
        question: "Where do you see yourself in 5 years?",
        answer: "Align your goals with the company's growth opportunities. Show ambition while being realistic about career progression.",
        tips: ["Research company career paths", "Show long-term thinking", "Demonstrate ambition and loyalty"]
      },
      {
        question: "Why did you choose this career path?",
        answer: "Share your genuine interest in the field. Mention specific experiences or moments that led to this decision.",
        tips: ["Be authentic and passionate", "Connect to personal experiences", "Show genuine interest in the field"]
      }
    ],
    'company': [
      {
        question: "Why do you want to work for this company?",
        answer: "Research the company's values, culture, and recent achievements. Connect these to your own values and career goals.",
        tips: ["Research company thoroughly", "Connect to your values", "Mention specific company achievements"]
      }
    ],
    'technical': [
      {
        question: `What technical skills are most important for success in ${careerPathTitle}?`,
        answer: "Discuss both hard and soft technical skills. Mention your proficiency level and how you stay current with technology.",
        tips: ["Mention specific technologies", "Show continuous learning", "Relate to job requirements"]
      }
    ],
    'behavioral': [
      {
        question: "Describe a time when you faced a significant challenge. How did you handle it?",
        answer: "Use the STAR method: Situation, Task, Action, Result. Focus on your problem-solving process and what you learned.",
        tips: ["Use the STAR method", "Show problem-solving skills", "Emphasize positive outcomes"]
      }
    ],
    'problem-solving': [
      {
        question: "How do you approach solving complex problems?",
        answer: "Outline your systematic approach: analyze the problem, research solutions, implement, and evaluate results.",
        tips: ["Show systematic thinking", "Mention analytical tools", "Emphasize learning from results"]
      }
    ],
    'teamwork': [
      {
        question: "How do you handle conflicts with team members?",
        answer: "Emphasize open communication, active listening, and finding common ground. Show maturity in conflict resolution.",
        tips: ["Show emotional intelligence", "Emphasize communication", "Focus on positive outcomes"]
      }
    ]
  };

  const categoryQuestions = fallbackQuestions[category] || fallbackQuestions['personal'];
  
  // Expand to 10 questions by adding variations
  const expandedQuestions = [...categoryQuestions];
  
  // Add generic questions to reach 10
  while (expandedQuestions.length < 10) {
    expandedQuestions.push({
      question: `What interests you most about working in ${careerPathTitle}?`,
      answer: "Focus on specific aspects of the field that excite you. Show genuine passion and knowledge about the industry.",
      tips: ["Be specific and passionate", "Show industry knowledge", "Connect to personal interests"]
    });
  }
  
  return expandedQuestions.slice(0, 10).map((q, index) => ({
    id: index + 1,
    question: q.question,
    answer: q.answer,
    tips: q.tips
  }));
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
      log(`Fetched talent: ${talent.fullname} (${Date.now() - startTime}ms)`);
    } catch (e) {
      return res.json({ success: false, error: 'Talent not found', statusCode: 404 }, 404);
    }

    // Quick timeout check
    if (Date.now() - startTime > 3000) {
      return res.json({ 
        success: false, 
        error: 'Function timeout - database queries took too long', 
        statusCode: 408 
      }, 408);
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
        log(`Fetched career path: ${careerPath.title} (${Date.now() - startTime}ms)`);
      } catch (e) {
        log(`Warning: Could not fetch career path: ${e.message}`);
      }
    }

    let questions;
    let usedFallback = false;
    
    // Try AI generation first
    try {
      // Initialize Gemini 2.5 Flash model with optimized settings
      const model = genAI.getGenerativeModel({ 
        model: "gemini-2.5-flash",
        generationConfig: { 
          maxOutputTokens: 2000,
          temperature: 0.3,
          topK: 40,
          topP: 0.9,
          candidateCount: 1
        }
      });

      const prompt = getCategoryPrompt(category, talent, careerPath);
      log(`Starting AI generation for ${QUESTION_CATEGORIES[category]} questions (${Date.now() - startTime}ms)`);
      
      // Try with 15 second timeout
      const result = await generateWithTimeout(model, prompt, 15000);
      const responseText = result.response.text();
      
      log(`AI generation completed in ${Date.now() - startTime}ms`);
      log(`Response length: ${responseText.length} characters`);
      
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

      log(`Successfully processed ${questions.length} AI-generated questions`);

    } catch (aiError) {
      error(`AI generation failed: ${aiError.message}`);
      log('Falling back to predefined questions...');
      
      // Use fallback questions
      questions = generateFallbackQuestions(category, talent, careerPath);
      usedFallback = true;
      
      log(`Using ${questions.length} fallback questions`);
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
        usedFallback: usedFallback
      }
    };

    log(`Generated ${questions.length} ${QUESTION_CATEGORIES[category]} questions in ${Date.now() - startTime}ms (fallback: ${usedFallback})`);
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