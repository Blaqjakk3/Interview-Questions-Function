import { Client, Databases } from 'node-appwrite';
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

    // Fetch talent information
    let talent;
    try {
      const talentQuery = await databases.listDocuments(
        config.databaseId,
        config.talentsCollectionId,
        [
          { method: 'equal', attribute: 'talentId', values: [talentId] }
        ]
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
    try {
      const model = genAI.getGenerativeModel({ 
        model: "gemini-1.5-flash",
        generationConfig: {
          maxOutputTokens: 4096,
          temperature: 0.7,
        }
      });

      // Build context for career stage
      const careerStageContext = {
        'Pathfinder': 'entry-level professional looking to start their career, focusing on internships and entry-level positions',
        'Trailblazer': 'mid-level professional looking to advance and grow in their current field',
        'Horizon Changer': 'experienced professional looking to transition to a new career field'
      };

      const careerStageDescription = careerStageContext[talent.careerStage] || 'professional';
      const careerPathTitle = careerPath ? careerPath.title : 'general career field';
      const careerPathDescription = careerPath ? careerPath.description || '' : '';

      const prompt = `Generate 25-30 mock interview questions and answers for a ${careerStageDescription} interested in ${careerPathTitle}.

Context:
- Career Stage: ${talent.careerStage} (${careerStageDescription})
- Career Path: ${careerPathTitle}
- Career Path Description: ${careerPathDescription}

Include a mix of:
1. 10-12 General behavioral and situational questions (applicable to most roles)
2. 15-18 Questions tailored specifically to the ${careerPathTitle} field

For each question, provide:
- question: The interview question
- type: Either "general" or "career-specific"
- category: Question category (e.g., "behavioral", "technical", "situational", "career-motivation")
- answer: A comprehensive sample answer tailored to the career stage
- tips: 2-3 specific tips for answering this question effectively

Tailor the complexity and expectations in answers based on the career stage:
- Pathfinder: Focus on potential, learning attitude, internship experiences, academic projects
- Trailblazer: Focus on concrete achievements, leadership examples, career progression
- Horizon Changer: Focus on transferable skills, motivation for change, relevant experience

Return only valid JSON array with objects containing the specified fields. No extra text or markdown.`;

      // Generate content
      log('Generating interview questions with Gemini...');
      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      log('Received response from Gemini');

      // Parse and validate questions
      let questions;
      try {
        const cleanedResponse = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        questions = JSON.parse(cleanedResponse);
        
        if (!Array.isArray(questions) || questions.length === 0) {
          throw new Error('Empty questions array');
        }

        // Validate question structure
        questions = questions.map((q, index) => ({
          id: index + 1,
          question: q.question || `Sample question ${index + 1}`,
          type: q.type || 'general',
          category: q.category || 'behavioral',
          answer: q.answer || 'Sample answer for interview preparation.',
          tips: Array.isArray(q.tips) ? q.tips : ['Practice your response', 'Be specific with examples'],
          ...q
        }));

      } catch (parseError) {
        error(`Failed to parse questions: ${parseError.message}`);
        return res.json({
          success: false,
          error: 'Failed to parse AI response',
          rawResponse: responseText,
          statusCode: 500
        }, 500);
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
          generatedAt: new Date().toISOString()
        }
      };

      log(`Successfully generated ${questions.length} interview questions`);
      return res.json(response);

    } catch (err) {
      error(`AI Generation Error: ${err.message}`);
      return res.json({
        success: false,
        error: 'Failed to generate interview questions',
        statusCode: 500
      }, 500);
    }

  } catch (err) {
    error(`Unexpected Error: ${err.message}`);
    return res.json({
      success: false,
      error: 'Internal server error',
      statusCode: 500
    }, 500);
  }
};