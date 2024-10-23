import { WebClient } from '@slack/web-api';
import { GeminiEmbedding } from 'llamaindex/embeddings/GeminiEmbedding';
import { Pinecone } from '@pinecone-database/pinecone'
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();


// Setting state that will hold the messages to be vectorized
const messages = [];

// State that would hold the vectors
const PineconeVectors = [];

// Slack token
// Had to hardcode the token
const token = process.env.SLACK_TOKEN;


// Initialize the Slack client
const slackClient = new WebClient(token);

// Function to fetch and return channel names
async function getChannelNames() {
    try {
        const result = await slackClient.conversations.list({
            types: 'public_channel', // You can specify public or private
        });

        // Extract channel names from the result
        const channelNames = result.channels.map(channel => channel.name);

        console.log('Channel Names:', channelNames);
        return channelNames;
    } catch (error) {
        console.error('Error fetching channels:', error);
    }
}

// Function to get channel ID from channel name
async function getChannelIdByName(channelName) {
    try {
        const result = await slackClient.conversations.list();
        const channel = result.channels.find(c => c.name === channelName);

        if (channel) {
            console.log(channel.id);
            return channel.id;

        } else {
            throw new Error(`Channel with name ${channelName} not found.`);
        }
    } catch (error) {
        console.error('Error fetching channel ID:', error);
    }
}

// Function to read messages from the channel using its ID
async function getMessagesFromChannel(channelId) {
    try {
        const result = await slackClient.conversations.history({
            channel: channelId,
            limit: 10 // You can set the limit to whatever number you need
        });

        // Extract and format messages as JSON
        const messagesJson = result.messages.map(message => ({
            user: message.user,
            text: message.text,
            ts: message.ts,
        }));

        console.log(messagesJson)
        messages.push(messagesJson);

        // Optionally, write the JSON to a file
        fs.writeFileSync('channel_messages.json', JSON.stringify(messagesJson, null, 2));

        console.log('Messages have been saved to channel_messages.json');
        return messagesJson;
    } catch (error) {
        console.error('Error fetching channel messages:', error);
    }
}



// Fetch and log the channel names
await getChannelNames();
await getChannelIdByName("all-new-workspace");
await getMessagesFromChannel("C07QP5MV8SJ");



// Embedding the vectors 
const geminiEmbedding = new GeminiEmbedding({
    model: process.env.EMBEDDING_MODEL,
    // apiKey: process.env.GOOGLE_API_KEY
    // HAD TO HARDCODE THE API KEY
    
});

async function vectorizeJSON(jsonData) {
    const vectors = await Promise.all(
        jsonData.map(async (items) => {
            // Ensure we return the inner map's promise array
            return Promise.all(
                items.map(async (item) => {
                    console.log(item.text);
                    const embedding = await geminiEmbedding.getTextEmbedding(item.text);
                    return embedding; // Properly return the embedding here
                })
            );
        })
    );
    
    vectors.map(vectorarray => {
        vectorarray.map(vector => {
            PineconeVectors.push(vector);
        })
    }); 
    
    return vectors;
}
// Usage
await vectorizeJSON(messages)

console.log(PineconeVectors);

// PINECONE

async function uploadVectorsToPinecone(vectors, messages) {
    try {
        // Initialize Pinecone client
        const pc = new Pinecone({
            apiKey: process.env.PINECONE_API_KEY
            // HAD TO HARDCODE THE API KEY
        
        });

        const index = pc.index("slackindex");

        // Format vectors for Pinecone upload
        const upsertData = vectors.map((vector, idx) => {
            return {
                id: `msg_${idx}`, // Unique ID for each vector
                values: vector,  // The actual vector values
                metadata: {
                    timestamp: messages[idx]?.ts || new Date().toISOString(),
                    user: messages[idx]?.user || 'unknown',
                    text: messages[idx]?.text || '',
                }
            };
        });

        // Batch upsert to handle potential size limitations
        const BATCH_SIZE = 100;
        for (let i = 0; i < upsertData.length; i += BATCH_SIZE) {
            const batch = upsertData.slice(i, i + BATCH_SIZE);
            await index.namespace('slack-messages').upsert(batch);
            console.log(`Uploaded batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(upsertData.length / BATCH_SIZE)}`);
        }

        console.log('Successfully uploaded all vectors to Pinecone');
        return true;

    } catch (error) {
        console.error('Error uploading vectors to Pinecone:', error);
        throw error;
    }
}

await uploadVectorsToPinecone(PineconeVectors, messages);
