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

    // Simplified prompt for direct, natural answers
    const prompt = `Generate exactly 10 interview questions for ${talent.fullname}, a ${careerStageDescription} interested in ${careerPathTitle}.

For each question, provide a direct, natural answer that would be appropriate for someone in their situation. Don't categorize the questions - just make them a good mix of general and field-specific questions that would be asked in a real interview.

Return ONLY a JSON array with this structure:
[
  {
    "question": "Tell me about yourself.",
    "answer": "I'm a motivated professional with [relevant background]. I have experience in [key areas] and I'm passionate about [field]. What excites me most about this opportunity is [specific reason]. I'm looking to [career goal] and believe this role aligns perfectly with my aspirations."
  }
]

Make the answers sound natural and conversational, not robotic. Each answer should be 2-4 sentences and directly address what the interviewer is looking for.`;

    log('Generating interview questions with Gemini...');
    
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    log('Received response from Gemini');

    // Parse questions
    let questions;
    try {
      // Clean response
      let cleanedResponse = responseText
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .replace(/^[^[]*/, '')
        .replace(/[^\]]*$/, ']');
      
      const jsonStart = cleanedResponse.indexOf('[');
      const jsonEnd = cleanedResponse.lastIndexOf(']') + 1;
      
      if (jsonStart !== -1 && jsonEnd > jsonStart) {
        cleanedResponse = cleanedResponse.substring(jsonStart, jsonEnd);
      }
      
      questions = JSON.parse(cleanedResponse);
      
      if (!Array.isArray(questions) || questions.length === 0) {
        throw new Error('Invalid questions array');
      }

      // Standardize question structure
      questions = questions.slice(0, 10).map((q, index) => ({
        id: index + 1,
        question: q.question || `Interview question ${index + 1}`,
        answer: q.answer || 'This is an opportunity to showcase your relevant experience and skills.'
      }));

      log(`Successfully processed ${questions.length} questions`);

    } catch (parseError) {
      error(`Failed to parse questions: ${parseError.message}`);
      return res.json({
        success: false,
        error: 'Failed to generate questions',
        statusCode: 500
      }, 500);
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
        executionTime: Date.now() - startTime
      }
    };

    log(`Successfully generated ${questions.length} interview questions in ${Date.now() - startTime}ms`);
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