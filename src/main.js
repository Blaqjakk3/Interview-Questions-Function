import { Client, Databases, Query } from 'node-appwrite';
import { GoogleGenerativeAI } from '@google/generative-ai';

const client = new Client();

const endpoint = process.env.APPWRITE_FUNCTION_ENDPOINT || 'https://cloud.appwrite.io/v1';
console.log('Using endpoint:', endpoint);

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

export default async ({ req, res, log, error }) => {
  const startTime = Date.now();
  
  try {
    log('=== Interview Questions Function Started ===');
    
    // Parse input with better error handling
    let requestData;
    try {
      requestData = JSON.parse(req.body);
    } catch (e) {
      error('Invalid JSON input');
      return res.json({
        success: false,
        error: 'Invalid JSON input',
        statusCode: 400
      }, 400);
    }

    const { talentId } = requestData;
    
    // Validate input
    if (!talentId) {
      error('Missing required parameter: talentId');
      return res.json({
        success: false,
        error: 'Missing talentId parameter',
        statusCode: 400
      }, 400);
    }

    log(`Looking for talent with talentId: ${talentId}`);

    // Fetch talent information with timeout
    let talent;
    try {
      const talentQuery = await Promise.race([
        databases.listDocuments(
          config.databaseId,
          config.talentsCollectionId,
          [Query.equal('talentId', talentId)]
        ),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Database query timeout')), 10000)
        )
      ]);

      log(`Query result: Found ${talentQuery.documents.length} documents`);

      if (talentQuery.documents.length === 0) {
        throw new Error('Talent not found');
      }

      talent = talentQuery.documents[0];
      log(`Fetched talent: ${talent.fullname}`);
    } catch (e) {
      error(`Failed to fetch talent: ${e.message}`);
      return res.json({
        success: false,
        error: 'Talent not found or database timeout',
        statusCode: 404
      }, 404);
    }

    // Fetch career path if selectedPath exists (with timeout)
    let careerPath = null;
    if (talent.selectedPath) {
      try {
        careerPath = await Promise.race([
          databases.getDocument(
            config.databaseId,
            config.careerPathsCollectionId,
            talent.selectedPath
          ),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Career path query timeout')), 5000)
          )
        ]);
        log(`Fetched career path: ${careerPath.title}`);
      } catch (e) {
        log(`Warning: Could not fetch career path ${talent.selectedPath}: ${e.message}`);
      }
    }

    // Check if we're approaching timeout (assume 15s timeout)
    const elapsedTime = Date.now() - startTime;
    if (elapsedTime > 12000) {
      log('Approaching timeout, returning fallback response');
      return res.json({
        success: false,
        error: 'Function timeout - please try again',
        statusCode: 408
      }, 408);
    }

    // Initialize Gemini with optimized settings
    try {
      const model = genAI.getGenerativeModel({ 
        model: "gemini-1.5-flash",
        generationConfig: {
          maxOutputTokens: 3000, // Reduced from 4096
          temperature: 0.5, // Reduced from 0.7 for faster generation
        }
      });

      // Build context for career stage
      const careerStageContext = {
        'Pathfinder': 'entry-level professional looking to start their career',
        'Trailblazer': 'mid-level professional looking to advance',
        'Horizon Changer': 'experienced professional looking to transition'
      };

      const careerStageDescription = careerStageContext[talent.careerStage] || 'professional';
      const careerPathTitle = careerPath ? careerPath.title : 'general career field';

      // Simplified and more concise prompt for faster generation
      const prompt = `Generate exactly 20 interview questions for a ${careerStageDescription} in ${careerPathTitle}.

Return ONLY a JSON array with this exact structure:
[
  {
    "question": "Tell me about yourself.",
    "type": "general",
    "category": "behavioral",
    "answer": "Sample answer focusing on relevant experience and skills.",
    "tips": ["Be concise", "Focus on relevant experience"]
  }
]

Include:
- 8 general questions (behavioral, situational)
- 12 career-specific questions for ${careerPathTitle}

Categories: behavioral, technical, situational, career-motivation

Keep answers under 100 words each. No markdown, no extra text.`;

      // Generate content with timeout
      log('Generating interview questions with Gemini...');
      
      const result = await Promise.race([
        model.generateContent(prompt),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('AI generation timeout')), 10000)
        )
      ]);
      
      const responseText = result.response.text();
      log('Received response from Gemini');

      // Parse and validate questions
      let questions;
      try {
        // Clean response more aggressively
        let cleanedResponse = responseText
          .replace(/```json\n?/g, '')
          .replace(/```\n?/g, '')
          .replace(/^[^[]*/, '') // Remove everything before first [
          .replace(/[^\]]*$/, ']'); // Remove everything after last ]
        
        // Find the JSON array in the response
        const jsonStart = cleanedResponse.indexOf('[');
        const jsonEnd = cleanedResponse.lastIndexOf(']') + 1;
        
        if (jsonStart !== -1 && jsonEnd > jsonStart) {
          cleanedResponse = cleanedResponse.substring(jsonStart, jsonEnd);
        }
        
        questions = JSON.parse(cleanedResponse);
        
        if (!Array.isArray(questions) || questions.length === 0) {
          throw new Error('Empty questions array');
        }

        // Validate and standardize question structure
        questions = questions.slice(0, 20).map((q, index) => ({
          id: index + 1,
          question: q.question || `Sample question ${index + 1}`,
          type: ['general', 'career-specific'].includes(q.type) ? q.type : 'general',
          category: q.category || 'behavioral',
          answer: q.answer || 'This question allows you to demonstrate your relevant experience and skills.',
          tips: Array.isArray(q.tips) ? q.tips.slice(0, 3) : ['Practice your response', 'Use specific examples']
        }));

        log(`Processed ${questions.length} questions successfully`);

      } catch (parseError) {
        error(`Failed to parse questions: ${parseError.message}`);
        
        // Return fallback questions instead of failing
        questions = generateFallbackQuestions(careerPathTitle, talent.careerStage);
        log('Using fallback questions due to parsing error');
      }

      // Create final response
      const response = {
        success: true,
        statusCode: 200,
        questions: questions,
        metadata: {
          totalQuestions: questions.length,
          generalQuestions: questions.filter(q => q.type === 'general').length,
          careerSpecificQuestions: questions.filter(q => q.type === 'career-specific').length,
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

      log(`Successfully generated ${questions.length} interview questions in ${Date.now() - startTime}ms`);
      return res.json(response);

    } catch (err) {
      error(`AI Generation Error: ${err.message}`);
      
      // Return fallback questions on AI error
      const fallbackQuestions = generateFallbackQuestions(
        careerPath?.title || 'general career field',
        talent.careerStage
      );
      
      return res.json({
        success: true,
        statusCode: 200,
        questions: fallbackQuestions,
        metadata: {
          totalQuestions: fallbackQuestions.length,
          generalQuestions: fallbackQuestions.filter(q => q.type === 'general').length,
          careerSpecificQuestions: fallbackQuestions.filter(q => q.type === 'career-specific').length,
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
          fallback: true
        }
      });
    }

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

// Fallback questions generator
function generateFallbackQuestions(careerField, careerStage) {
  const baseQuestions = [
    {
      id: 1,
      question: "Tell me about yourself.",
      type: "general",
      category: "behavioral",
      answer: "Focus on your professional background, relevant skills, and what makes you a good fit for this role.",
      tips: ["Keep it professional", "Highlight relevant experience", "End with why you're interested in this role"]
    },
    {
      id: 2,
      question: "Why are you interested in this position?",
      type: "general",
      category: "career-motivation",
      answer: "Connect your career goals with the role requirements and company mission.",
      tips: ["Research the company", "Show genuine interest", "Connect to career goals"]
    },
    {
      id: 3,
      question: "What are your greatest strengths?",
      type: "general",
      category: "behavioral",
      answer: "Choose strengths relevant to the job and provide specific examples.",
      tips: ["Use job-relevant strengths", "Provide concrete examples", "Show impact"]
    },
    {
      id: 4,
      question: "Describe a challenging situation you faced and how you handled it.",
      type: "general",
      category: "situational",
      answer: "Use the STAR method: Situation, Task, Action, Result.",
      tips: ["Use STAR method", "Show problem-solving skills", "Highlight positive outcome"]
    },
    {
      id: 5,
      question: "Where do you see yourself in 5 years?",
      type: "general",
      category: "career-motivation",
      answer: "Show ambition while aligning with the role's growth potential.",
      tips: ["Be realistic", "Show ambition", "Align with role growth"]
    }
  ];

  // Add career-specific fallback questions based on field
  const careerSpecificQuestions = [
    {
      id: 6,
      question: `What interests you most about working in ${careerField}?`,
      type: "career-specific",
      category: "career-motivation",
      answer: "Express genuine passion for the field and its challenges.",
      tips: ["Show genuine interest", "Mention industry trends", "Connect to personal values"]
    },
    {
      id: 7,
      question: `How do you stay current with developments in ${careerField}?`,
      type: "career-specific",
      category: "technical",
      answer: "Mention specific resources, courses, or communities you follow.",
      tips: ["Name specific resources", "Show continuous learning", "Mention recent trends"]
    }
  ];

  return [...baseQuestions, ...careerSpecificQuestions];
}