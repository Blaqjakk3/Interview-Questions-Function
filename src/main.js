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

// Helper function to clean and extract JSON from AI response
function extractAndCleanJSON(text) {
  try {
    // Remove common markdown formatting
    let cleaned = text
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();

    // Find the JSON array bounds
    const startIndex = cleaned.indexOf('[');
    const lastIndex = cleaned.lastIndexOf(']');
    
    if (startIndex === -1 || lastIndex === -1 || startIndex >= lastIndex) {
      throw new Error('No valid JSON array found in response');
    }
    
    // Extract just the JSON array
    cleaned = cleaned.substring(startIndex, lastIndex + 1);
    
    // Additional cleaning for common AI response issues
    cleaned = cleaned
      .replace(/,(\s*[}\]])/g, '$1') // Remove trailing commas
      .replace(/([{,]\s*)(\w+):/g, '$1"$2":') // Quote unquoted keys
      .replace(/:\s*'([^']*)'/g, ': "$1"') // Replace single quotes with double quotes
      .replace(/\n/g, ' ') // Remove newlines
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
    
    return cleaned;
  } catch (error) {
    throw new Error(`Failed to clean JSON: ${error.message}`);
  }
}

// Fallback questions generator
function generateFallbackQuestions(talent, careerPath) {
  const careerTitle = careerPath ? careerPath.title : 'your chosen field';
  const stage = talent.careerStage;
  
  const fallbackQuestions = [
    {
      question: "Tell me about yourself.",
      answer: `I'm a motivated ${stage === 'Pathfinder' ? 'entry-level' : stage === 'Trailblazer' ? 'mid-level' : 'experienced'} professional passionate about ${careerTitle}. I have a strong foundation in relevant skills and I'm eager to contribute to meaningful projects while continuing to grow in my career.`
    },
    {
      question: "Why are you interested in this position?",
      answer: `This role aligns perfectly with my career goals in ${careerTitle}. I'm excited about the opportunity to apply my skills, learn from experienced team members, and contribute to impactful projects in this field.`
    },
    {
      question: "What are your greatest strengths?",
      answer: "My greatest strengths include strong problem-solving abilities, excellent communication skills, and a genuine passion for continuous learning. I'm also highly adaptable and work well both independently and as part of a team."
    },
    {
      question: "Where do you see yourself in 5 years?",
      answer: `In five years, I see myself as a skilled professional in ${careerTitle}, having gained significant experience and expertise. I'd like to be in a position where I can mentor others and lead meaningful projects that make a real impact.`
    },
    {
      question: "What motivates you?",
      answer: "I'm motivated by the opportunity to solve complex problems, learn new technologies, and make a positive impact through my work. I find great satisfaction in overcoming challenges and contributing to team success."
    },
    {
      question: "How do you handle pressure and tight deadlines?",
      answer: "I handle pressure by staying organized, prioritizing tasks effectively, and maintaining clear communication with my team. I break large projects into manageable steps and focus on delivering quality work within the given timeframe."
    },
    {
      question: "Describe a challenge you've overcome.",
      answer: "I once faced a complex project that required learning new technologies quickly. I approached it systematically by breaking down the requirements, researching best practices, and seeking guidance from mentors. Through persistence and structured learning, I successfully completed the project."
    },
    {
      question: "Why should we hire you?",
      answer: `You should hire me because I bring a unique combination of technical skills, enthusiasm for ${careerTitle}, and a strong work ethic. I'm committed to growing with the company and contributing to its success while delivering high-quality results.`
    },
    {
      question: "What are your salary expectations?",
      answer: "I'm looking for a competitive salary that reflects the value I can bring to the role and is in line with industry standards for this position. I'm open to discussing compensation based on the full package and growth opportunities."
    },
    {
      question: "Do you have any questions for us?",
      answer: "Yes, I'd love to know more about the team I'd be working with, the company's growth plans, and what success looks like in this role. I'm also curious about professional development opportunities and the company culture."
    }
  ];

  return fallbackQuestions.slice(0, 10).map((q, index) => ({
    id: index + 1,
    question: q.question,
    answer: q.answer
  }));
}

export default async ({ req, res, log, error }) => {
  const startTime = Date.now();
  
  try {
    log('=== Interview Questions Function Started ===');
    
    // Parse input
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
    
    if (!talentId) {
      error('Missing required parameter: talentId');
      return res.json({
        success: false,
        error: 'Missing talentId parameter',
        statusCode: 400
      }, 400);
    }

    log(`Looking for talent with talentId: ${talentId}`);

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
      error(`Failed to fetch talent: ${e.message}`);
      return res.json({
        success: false,
        error: 'Talent not found',
        statusCode: 404
      }, 404);
    }

    // Fetch career path if selectedPath exists
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
        log(`Warning: Could not fetch career path ${talent.selectedPath}: ${e.message}`);
      }
    }

    let questions;
    let usedFallback = false;

    try {
      // Initialize Gemini
      const model = genAI.getGenerativeModel({ 
        model: "gemini-1.5-flash",
        generationConfig: {
          maxOutputTokens: 2000,
          temperature: 0.7,
        }
      });

      // Build context for career stage
      const careerStageContext = {
        'Pathfinder': 'entry-level professional starting their career',
        'Trailblazer': 'mid-level professional advancing their career',
        'Horizon Changer': 'experienced professional transitioning careers'
      };

      const careerStageDescription = careerStageContext[talent.careerStage] || 'professional';
      const careerPathTitle = careerPath ? careerPath.title : 'their chosen field';

      // More specific prompt for better JSON generation
      const prompt = `You are an expert interviewer. Generate exactly 10 interview questions with answers for ${talent.fullname}, a ${careerStageDescription} interested in ${careerPathTitle}.

IMPORTANT: Return ONLY a valid JSON array. No explanations, no markdown, no extra text.

Format:
[
  {
    "question": "Tell me about yourself.",
    "answer": "I'm a motivated professional with relevant background in ${careerPathTitle}. I have experience in key areas and I'm passionate about this field. What excites me most about opportunities in ${careerPathTitle} is the chance to make a meaningful impact. I'm looking to grow my career and believe this aligns with my aspirations."
  }
]

Rules:
- Make answers 2-4 sentences each
- Sound natural and conversational
- Mix general and field-specific questions
- Each answer should directly address what interviewers want to hear
- Return valid JSON only`;

      log('Generating interview questions with Gemini...');
      
      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      log('Received response from Gemini');

      // Clean and parse the response
      const cleanedJson = extractAndCleanJSON(responseText);
      log('Cleaned JSON response');
      
      const parsedQuestions = JSON.parse(cleanedJson);
      
      if (!Array.isArray(parsedQuestions) || parsedQuestions.length === 0) {
        throw new Error('Invalid questions array from AI');
      }

      // Standardize and validate questions
      questions = parsedQuestions.slice(0, 10).map((q, index) => {
        if (!q.question || !q.answer) {
          throw new Error(`Invalid question structure at index ${index}`);
        }
        return {
          id: index + 1,
          question: q.question.trim(),
          answer: q.answer.trim()
        };
      });

      log(`Successfully processed ${questions.length} AI-generated questions`);

    } catch (aiError) {
      log(`AI generation failed: ${aiError.message}, using fallback questions`);
      questions = generateFallbackQuestions(talent, careerPath);
      usedFallback = true;
    }

    // Create response
    const response = {
      success: true,
      statusCode: 200,
      questions: questions,
      metadata: {
        totalQuestions: questions.length,
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

    log(`Successfully generated ${questions.length} interview questions in ${Date.now() - startTime}ms ${usedFallback ? '(fallback)' : '(AI)'}`);
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