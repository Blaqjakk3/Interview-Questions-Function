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
      talent = await databases.getDocument(
        config.databaseId,
        config.talentsCollectionId,
        talentId
      );
      log(`Fetched talent: ${talent.fullname}`);
    } catch (e) {
      error(`Failed to fetch talent: ${e.message}`);
      return res.json({
        success: false,
        error: 'Talent not found',
        statusCode: 404
      }, 404);
    }

    // Fetch career path information
    let careerPath;
    try {
      if (talent.selectedPath) {
        careerPath = await databases.getDocument(
          config.databaseId,
          config.careerPathsCollectionId,
          talent.selectedPath
        );
        log(`Fetched career path: ${careerPath.title}`);
      }
    } catch (e) {
      error(`Failed to fetch career path: ${e.message}`);
      return res.json({
        success: false,
        error: 'Career path not found',
        statusCode: 404
      }, 404);
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

      // Create detailed prompt based on career stage and path
      const careerStageContext = {
        'Pathfinder': 'entry-level candidate who is just starting their career journey and looking for internships or junior positions',
        'Trailblazer': 'mid-level professional looking to advance their career and move up the ladder in their field',
        'Horizon Changer': 'experienced professional from another field looking to transition into a new career path'
      };

      const prompt = `Generate 25 mock interview questions and answers for a ${talent.careerStage} in ${careerPath ? careerPath.title : 'their chosen field'}.

Context:
- Career Stage: ${talent.careerStage} (${careerStageContext[talent.careerStage]})
- Career Path: ${careerPath ? careerPath.title : 'General'}
- Skills: ${talent.skills ? talent.skills.join(', ') : 'General skills'}
- Interests: ${talent.interests ? talent.interests.join(', ') : 'General interests'}

Requirements:
1. Include 10-12 general behavioral/situational questions applicable to most professional roles
2. Include 13-15 questions specifically tailored to the ${careerPath ? careerPath.title : 'chosen career path'}
3. Adjust question difficulty and expectations based on the ${talent.careerStage} career stage
4. Provide comprehensive, realistic answers that would be appropriate for someone at this career stage
5. For Pathfinder: Focus on potential, willingness to learn, and relevant coursework/projects
6. For Trailblazer: Focus on experience, leadership, and career growth
7. For Horizon Changer: Focus on transferable skills, motivation for change, and relevant experience from previous field

Return only valid JSON array with objects containing:
- question: The interview question
- answer: A comprehensive sample answer (2-3 sentences minimum)
- category: Either "behavioral" or "technical" or "career-specific"
- difficulty: "easy", "medium", or "hard"

Format: JSON array only, no extra text or markdown.`;

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
        questions: questions.map(q => ({
          question: q.question || 'Sample interview question',
          answer: q.answer || 'Sample answer for the question',
          category: q.category || 'behavioral',
          difficulty: q.difficulty || 'medium',
          ...q
        })),
        talent: {
          id: talent.$id,
          fullname: talent.fullname,
          careerStage: talent.careerStage
        },
        careerPath: careerPath ? {
          id: careerPath.$id,
          title: careerPath.title
        } : null,
        metadata: {
          totalQuestions: questions.length,
          careerStage: talent.careerStage,
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