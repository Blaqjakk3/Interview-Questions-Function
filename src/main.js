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

function extractAndCleanJSON(text) {
  try {
    let cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const startIndex = cleaned.indexOf('[');
    const lastIndex = cleaned.lastIndexOf(']');
    
    if (startIndex === -1 || lastIndex === -1 || startIndex >= lastIndex) {
      throw new Error('No valid JSON array found in response');
    }
    
    cleaned = cleaned.substring(startIndex, lastIndex + 1)
      .replace(/,(\s*[}\]])/g, '$1')
      .replace(/([{,]\s*)(\w+):/g, '$1"$2":')
      .replace(/:\s*'([^']*)'/g, ': "$1"')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    return cleaned;
  } catch (error) {
    throw new Error(`Failed to clean JSON: ${error.message}`);
  }
}

function generateFallbackQuestions(talent, careerPath) {
  const careerTitle = careerPath ? careerPath.title : 'your chosen field';
  const stage = talent.careerStage;
  const skills = talent.skills || [];
  const degrees = talent.degrees || [];
  const interests = talent.interests || [];

  const fallbackQuestions = [
    {
      question: "Tell me about yourself.",
      answer: `I'm a motivated ${stage === 'Pathfinder' ? 'entry-level' : stage === 'Trailblazer' ? 'mid-level' : 'experienced'} professional passionate about ${careerTitle}. ${degrees.length > 0 ? `I have a ${degrees[0]} degree, ` : ''}and I've developed skills in ${skills.slice(0, 3).join(', ') || 'relevant technologies'}. I'm eager to contribute to meaningful projects while continuing to grow in my career.`,
      tips: [
        "Keep your response to 60-90 seconds - practice timing it",
        "Structure it as: current situation → relevant experience → future goals",
        "End with enthusiasm about the specific role and company"
      ]
    },
    {
      question: "Why are you interested in this position?",
      answer: `This role aligns perfectly with my career goals in ${careerTitle}. ${interests.length > 0 ? `My passion for ${interests[0]} drives my interest in this field. ` : ''}I'm excited about the opportunity to apply my skills in ${skills.slice(0, 2).join(' and ') || 'relevant areas'} and contribute to impactful projects.`,
      tips: [
        "Research the company and mention specific aspects that attract you",
        "Connect your skills and interests to the job requirements",
        "Show genuine enthusiasm - passion is contagious"
      ]
    },
    {
      question: "What are your greatest strengths?",
      answer: `My greatest strengths include strong problem-solving abilities, excellent communication skills, and expertise in ${skills.slice(0, 2).join(' and ') || 'key technical areas'}. I'm also highly adaptable and work well both independently and as part of a team.`,
      tips: [
        "Choose strengths that are relevant to the job description",
        "Provide specific examples to back up each strength you mention",
        "Avoid generic answers - be specific about how you demonstrate these strengths"
      ]
    },
    {
      question: "Where do you see yourself in 5 years?",
      answer: `In five years, I see myself as a skilled professional in ${careerTitle}, having gained significant experience in ${skills.slice(0, 2).join(' and ') || 'key areas'}. I'd like to be in a position where I can mentor others and lead meaningful projects that make a real impact.`,
      tips: [
        "Show ambition but stay realistic and relevant to the role",
        "Demonstrate that you plan to grow within the company",
        "Mention skills you want to develop that align with company needs"
      ]
    },
    {
      question: "What motivates you?",
      answer: `I'm motivated by the opportunity to solve complex problems and make a positive impact through my work. ${interests.length > 0 ? `My interest in ${interests[0]} drives me to continuously learn and innovate. ` : ''}I find great satisfaction in overcoming challenges and contributing to team success.`,
      tips: [
        "Be authentic - share what genuinely drives you",
        "Connect your motivation to the role and company mission",
        "Avoid cliché answers like 'money' or 'success' - focus on purpose"
      ]
    },
    {
      question: "How do you handle pressure and tight deadlines?",
      answer: "I handle pressure by staying organized, prioritizing tasks effectively, and maintaining clear communication with my team. I break large projects into manageable steps and focus on delivering quality work within the given timeframe.",
      tips: [
        "Provide a specific example of when you successfully managed pressure",
        "Mention tools or techniques you use for time management",
        "Show that you can maintain quality even under pressure"
      ]
    },
    {
      question: "Describe a challenge you've overcome.",
      answer: `I once faced a complex project that required learning ${skills[0] || 'new technologies'} quickly. I approached it systematically by breaking down the requirements, researching best practices, and seeking guidance from mentors. Through persistence and structured learning, I successfully completed the project.`,
      tips: [
        "Use the STAR method: Situation, Task, Action, Result",
        "Choose a challenge that's relevant to the role you're applying for",
        "Focus on your problem-solving process and what you learned"
      ]
    },
    {
      question: "Why should we hire you?",
      answer: `You should hire me because I bring a unique combination of ${skills.slice(0, 2).join(' and ') || 'technical skills'}, enthusiasm for ${careerTitle}, and a strong work ethic. ${degrees.length > 0 ? `My ${degrees[0]} background provides a solid foundation, ` : ''}and I'm committed to growing with the company while delivering high-quality results.`,
      tips: [
        "Summarize your top 3 unique selling points",
        "Quantify your achievements where possible",
        "End with confidence and enthusiasm about contributing to their team"
      ]
    },
    {
      question: "What are your salary expectations?",
      answer: "I'm looking for a competitive salary that reflects the value I can bring to the role and is in line with industry standards for this position. I'm open to discussing compensation based on the full package and growth opportunities.",
      tips: [
        "Research salary ranges for the position beforehand",
        "Consider the total compensation package, not just base salary",
        "Be flexible but know your worth and minimum acceptable offer"
      ]
    },
    {
      question: "Do you have any questions for us?",
      answer: "Yes, I'd love to know more about the team I'd be working with, the company's growth plans, and what success looks like in this role. I'm also curious about professional development opportunities and how the company supports career growth.",
      tips: [
        "Always have 2-3 thoughtful questions prepared",
        "Ask about growth opportunities, team dynamics, and company culture",
        "Avoid questions about salary, benefits, or time off in the first interview"
      ]
    }
  ];

  return fallbackQuestions.slice(0, 10).map((q, index) => ({
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

    const { talentId } = requestData;
    if (!talentId) {
      return res.json({ success: false, error: 'Missing talentId parameter', statusCode: 400 }, 400);
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
        log(`Warning: Could not fetch career path: ${e.message}`);
      }
    }

    let questions;
    let usedFallback = false;

    try {
      const model = genAI.getGenerativeModel({ 
        model: "gemini-1.5-flash",
        generationConfig: { maxOutputTokens: 3000, temperature: 0.7 }
      });

      const careerStageDescription = {
        'Pathfinder': 'entry-level professional starting their career',
        'Trailblazer': 'mid-level professional advancing their career',
        'Horizon Changer': 'experienced professional transitioning careers'
      }[talent.careerStage] || 'professional';

      const careerPathTitle = careerPath ? careerPath.title : 'their chosen field';
      const skills = talent.skills || [];
      const degrees = talent.degrees || [];
      const interests = talent.interests || [];
      const certifications = talent.certifications || [];

      const talentContext = [
        skills.length > 0 ? `Skills: ${skills.join(', ')}` : '',
        degrees.length > 0 ? `Education: ${degrees.join(', ')}` : '',
        interests.length > 0 ? `Interests: ${interests.join(', ')}` : '',
        certifications.length > 0 ? `Certifications: ${certifications.join(', ')}` : ''
      ].filter(Boolean).join('. ');

      const prompt = `Generate exactly 10 interview questions with answers and 3 practical tips each for ${talent.fullname}, a ${careerStageDescription} interested in ${careerPathTitle}.

${talentContext ? `Talent Profile: ${talentContext}` : ''}

Return ONLY valid JSON array:
[
  {
    "question": "Tell me about yourself.",
    "answer": "Personalized answer incorporating their background and skills...",
    "tips": [
      "Specific actionable tip 1",
      "Specific actionable tip 2", 
      "Specific actionable tip 3"
    ]
  }
]

Requirements:
- Include mix of behavioral, technical, and situational questions
- Answers should be 2-4 sentences, natural and conversational
- Tips must be specific, actionable advice (not generic)
- Incorporate their skills, education, and interests where relevant
- Return valid JSON only, no extra text`;

      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      
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

      log(`Successfully processed ${questions.length} AI-generated questions with tips`);

    } catch (aiError) {
      log(`AI generation failed: ${aiError.message}, using fallback questions`);
      questions = generateFallbackQuestions(talent, careerPath);
      usedFallback = true;
    }

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

    log(`Generated ${questions.length} questions with tips in ${Date.now() - startTime}ms ${usedFallback ? '(fallback)' : '(AI)'}`);
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