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

    const elapsedTime = Date.now() - startTime;
    if (elapsedTime > 12000) {
      log('Approaching timeout, returning error response');
      return res.json({
        success: false,
        error: 'Function timeout - please try again',
        statusCode: 408
      }, 408);
    }

    try {
      const model = genAI.getGenerativeModel({ 
        model: "gemini-1.5-flash",
        generationConfig: {
          maxOutputTokens: 2000,
          temperature: 0.5,
        }
      });

      const careerStageContext = {
        'Pathfinder': 'entry-level professional',
        'Trailblazer': 'mid-level professional',
        'Horizon Changer': 'experienced professional'
      };

      const careerStageDescription = careerStageContext[talent.careerStage] || 'professional';
      const careerPathTitle = careerPath ? careerPath.title : 'general career field';

      const prompt = `Generate exactly 10 interview questions for a ${careerStageDescription} in ${careerPathTitle}.

Return ONLY a JSON array with this structure:
[
  {
    "question": "Question text",
    "type": "general or career-specific",
    "answer": "Direct answer to the question",
    "tips": []
  }
]

Include a mix of general and career-specific questions. Keep answers concise.`;

      log('Generating interview questions with Gemini...');
      
      const result = await Promise.race([
        model.generateContent(prompt),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('AI generation timeout')), 10000)
        )
      ]);
      
      const responseText = result.response.text();
      log('Received response from Gemini');

      let questions;
      try {
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
          throw new Error('Empty questions array');
        }

        questions = questions.slice(0, 10).map((q, index) => ({
          id: index + 1,
          question: q.question || `Sample question ${index + 1}`,
          type: q.type || 'general',
          answer: q.answer || 'This question allows you to demonstrate your relevant experience.',
          tips: q.tips || []
        }));

        log(`Processed ${questions.length} questions successfully`);

      } catch (parseError) {
        error(`Failed to parse questions: ${parseError.message}`);
        throw new Error('Failed to generate questions');
      }

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
      return res.json({
        success: false,
        error: 'Failed to generate questions',
        statusCode: 500
      }, 500);
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