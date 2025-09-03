// generate-previews.js
// Script to generate static matchup previews for your fantasy football app

const fs = require('fs').promises;
const path = require('path');

// Configuration
const CONFIG = {
    SLEEPER_LEAGUE_ID: "1257104566718042112",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY, // Set in GitHub Secrets
    API_BASE_URL: "https://api.sleeper.app/v1",
    OUTPUT_FILE: 'public/previews.json'
};

// Utility to add delays for rate limiting
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Fetch with error handling
async function fetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`API error: ${response.status}`);
            return await response.json();
        } catch (error) {
            console.log(`Attempt ${i + 1} failed for ${url}:`, error.message);
            if (i === retries - 1) throw error;
            await delay(1000 * (i + 1)); // Exponential backoff
        }
    }
}

// Sleeper API functions
class SleeperAPI {
    static async getLeague() {
        return fetchWithRetry(`${CONFIG.API_BASE_URL}/league/${CONFIG.SLEEPER_LEAGUE_ID}`);
    }

    static async getUsers() {
        return fetchWithRetry(`${CONFIG.API_BASE_URL}/league/${CONFIG.SLEEPER_LEAGUE_ID}/users`);
    }

    static async getRosters() {
        return fetchWithRetry(`${CONFIG.API_BASE_URL}/league/${CONFIG.SLEEPER_LEAGUE_ID}/rosters`);
    }

    static async getMatchups(week) {
        return fetchWithRetry(`${CONFIG.API_BASE_URL}/league/${CONFIG.SLEEPER_LEAGUE_ID}/matchups/${week}`);
    }

    static async getPlayers() {
        return fetchWithRetry(`${CONFIG.API_BASE_URL}/players/nfl`);
    }
}

// Data processing functions
function processRosterData(roster, matchupData, players) {
    const starters = matchupData?.starters || [];
    const bench = roster.players ? roster.players.filter(p => !starters.includes(p)) : [];
    
    const processPlayer = (playerId) => {
        const player = players[playerId];
        if (!player) {
            return {
                id: playerId,
                name: `Unknown (${playerId})`,
                position: 'UNKNOWN',
                team: null
            };
        }
        
        return {
            id: playerId,
            name: player.full_name,
            position: player.position,
            team: player.team,
            status: player.injury_status || 'Healthy',
            age: player.age,
            roastLevel: calculateRoastLevel(player)
        };
    };
    
    return {
        ...roster,
        starters: starters.map(processPlayer),
        bench: bench.map(processPlayer)
    };
}

function calculateRoastLevel(player) {
    if (!player) return 0;
    let score = 0;
    
    if (player.age >= 32) score++;
    if (player.age >= 35) score++;
    if ((player.search_rank || 0) > 1000) score++;
    if ((player.search_rank || 0) > 2000) score++;
    if ((player.depth_chart_order || 1) >= 3) score++;
    if (player.injury_status && player.injury_status !== 'Healthy') score++;
    
    return Math.min(score, 4);
}

function groupBy(array, key) {
    return array.reduce((result, item) => {
        const group = item[key];
        if (!result[group]) result[group] = [];
        result[group].push(item);
        return result;
    }, {});
}

// OpenAI Preview Generation
async function generateMatchupPreview(game, leagueData) {
    if (!CONFIG.OPENAI_API_KEY) {
        console.log('No OpenAI API key found, skipping AI preview generation');
        return null;
    }

    const prompt = buildPrompt(game, leagueData);
    
    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-3.5-turbo',
                messages: [{
                    role: 'system',
                    content: 'You are a fantasy football analyst writing engaging matchup previews. Use only the provided Sleeper API data. Structure your analysis in three sections: MATCHUP PREVIEW, PLAYERS TO WATCH, and PREDICTION. Write in an entertaining, analytical style.'
                }, {
                    role: 'user',
                    content: prompt
                }],
                temperature: 0.85,
                max_tokens: 1200
            })
        });

        if (!response.ok) {
            console.error('OpenAI API error:', response.status, await response.text());
            return null;
        }
        
        const data = await response.json();
        return JSON.parse(data.choices[0].message.content);
    } catch (error) {
        console.error('Error generating preview:', error);
        return null;
    }
}

function buildPrompt(game, leagueData) {
    let prompt = `WEEK ${leagueData.currentWeek} MATCHUP PREVIEW\n\n`;
    prompt += `MATCHUP: ${game.team1.teamName} vs ${game.team2.teamName}\n`;
    prompt += `${game.team1.manager} (${game.team1.record}) vs ${game.team2.manager} (${game.team2.record})\n\n`;
    
    // Add roster information
    ['team1', 'team2'].forEach(team => {
        const teamData = game[team];
        prompt += `${teamData.manager}'s Lineup:\n`;
        
        if (teamData.starters.length > 0) {
            const byPosition = groupBy(teamData.starters, 'position');
            Object.entries(byPosition).forEach(([pos, players]) => {
                prompt += `${pos}: ${players.map(p => p.name).join(', ')}\n`;
            });
        } else {
            prompt += `Lineup not yet set\n`;
        }
        prompt += '\n';
    });
    
    prompt += `This week's projections: ${game.team1.manager} ${game.team1.projected.toFixed(1)} pts, ${game.team2.manager} ${game.team2.projected.toFixed(1)} pts\n\n`;
    
    prompt += `Write a 400+ word analysis with three sections: MATCHUP PREVIEW, PLAYERS TO WATCH, and PREDICTION.\n`;
    prompt += `Return JSON: {"preview": "your full analysis"}`;
    
    return prompt;
}

// Main function
async function generatePreviews() {
    console.log('🚀 Starting preview generation...');
    
    try {
        // Fetch all required data
        console.log('📊 Fetching league data...');
        const [league, users, rosters, players] = await Promise.all([
            SleeperAPI.getLeague(),
            SleeperAPI.getUsers(),
            SleeperAPI.getRosters(),
            SleeperAPI.getPlayers()
        ]);

        const currentWeek = league.settings?.leg || 1;
        console.log(`🏈 Processing Week ${currentWeek} matchups...`);

        // Get current matchups
        const currentMatchups = await SleeperAPI.getMatchups(currentWeek);
        
        // Process rosters
        const detailedRosters = rosters.map(roster => {
            const matchupData = currentMatchups.find(m => m.roster_id === roster.roster_id);
            return processRosterData(roster, matchupData, players);
        });

        // Create manager data
        const managers = detailedRosters.map(roster => {
            const user = users.find(u => u.user_id === roster.owner_id) || {
                user_id: roster.owner_id,
                display_name: 'Unknown Manager'
            };
            
            return {
                ...user,
                roster_id: roster.roster_id,
                wins: roster.settings?.wins || 0,
                losses: roster.settings?.losses || 0,
                record: `${roster.settings?.wins || 0}-${roster.settings?.losses || 0}`,
                teamName: roster.metadata?.team_name || 
                         roster.settings?.team_name || 
                         user.metadata?.team_name || 
                         `${user.display_name}'s Team`,
                starters: roster.starters || [],
                bench: roster.bench || []
            };
        });

        // Process matchups into games
        const matchupGroups = groupBy(currentMatchups, 'matchup_id');
        const games = Object.values(matchupGroups)
            .filter(pair => pair.length === 2)
            .map((pair, index) => {
                const team1 = managers.find(m => m.roster_id === pair[0].roster_id);
                const team2 = managers.find(m => m.roster_id === pair[1].roster_id);
                
                return {
                    id: `game-${index + 1}`,
                    team1: {
                        manager: team1?.display_name,
                        teamName: team1?.teamName,
                        record: team1?.record,
                        projected: pair[0].points_projected || 0,
                        starters: team1?.starters || [],
                        bench: team1?.bench || []
                    },
                    team2: {
                        manager: team2?.display_name,
                        teamName: team2?.teamName,
                        record: team2?.record,
                        projected: pair[1].points_projected || 0,
                        starters: team2?.starters || [],
                        bench: team2?.bench || []
                    }
                };
            });

        console.log(`🎮 Found ${games.length} games to process`);

        // Generate previews
        const previews = {};
        const leagueData = { league, currentWeek };
        
        for (let i = 0; i < games.length; i++) {
            const game = games[i];
            console.log(`🤖 Generating preview ${i + 1}/${games.length}: ${game.team1.teamName} vs ${game.team2.teamName}`);
            
            const preview = await generateMatchupPreview(game, leagueData);
            
            if (preview) {
                previews[game.id] = preview;
                console.log(`✅ Generated preview for ${game.id}`);
            } else {
                console.log(`⚠️ Failed to generate preview for ${game.id}, will use fallback`);
            }
            
            // Rate limiting: Wait between requests
            if (i < games.length - 1) {
                await delay(2000); // 2 second delay between requests
            }
        }

        // Ensure public directory exists
        await fs.mkdir(path.dirname(CONFIG.OUTPUT_FILE), { recursive: true });
        
        // Write previews to file
        await fs.writeFile(CONFIG.OUTPUT_FILE, JSON.stringify(previews, null, 2));
        
        console.log(`🎉 Successfully generated ${Object.keys(previews).length} previews`);
        console.log(`📁 Saved to: ${CONFIG.OUTPUT_FILE}`);
        
        // Create generation timestamp
        const timestamp = {
            generated_at: new Date().toISOString(),
            week: currentWeek,
            league_name: league.name,
            total_previews: Object.keys(previews).length
        };
        
        await fs.writeFile('public/preview-info.json', JSON.stringify(timestamp, null, 2));
        
        console.log('✨ Preview generation complete!');
        
    } catch (error) {
        console.error('❌ Error generating previews:', error);
        process.exit(1);
    }
}

// Handle command line execution
if (require.main === module) {
    generatePreviews();
}

module.exports = { generatePreviews };
