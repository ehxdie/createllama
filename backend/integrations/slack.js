import { WebClient } from '@slack/web-api';
import { GeminiEmbedding } from 'llamaindex/embeddings/GeminiEmbedding';
import { Pinecone } from '@pinecone-database/pinecone';
import fs from 'fs';
import dotenv from 'dotenv';
import { jsonToDoc } from 'llamaindex/storage/docStore/utils';

dotenv.config();

// Setting state that will hold the messages to be vectorized
const messages = [];
const PineconeVectors = [];

// Slack token
const token = process.env.SLACK_TOKEN;


// Initialize the Slack client
const slackClient = new WebClient(token);

// Fetch channel names
async function getChannelNames() {
    try {
        const result = await slackClient.conversations.list({ types: 'public_channel' });
        const channelNames = result.channels.map(channel => channel.name);
        console.log('Channel Names:', channelNames);
        return channelNames;
    } catch (error) {
        console.error('Error fetching channels:', error);
    }
}

// Get channel ID from name
async function getChannelIdByName(channelName) {
    try {
        const result = await slackClient.conversations.list();
        const channel = result.channels.find(c => c.name === channelName);
        if (channel) return channel.id;
        else throw new Error(`Channel with name ${channelName} not found.`);
    } catch (error) {
        console.error('Error fetching channel ID:', error);
    }
}

// Get messages from channel ID
async function getMessagesFromChannel(channelId) {
    try {
        const result = await slackClient.conversations.history({ channel: channelId, limit: 10 });
        const messagesJson = result.messages.map(message => ({
            user: message.user,
            text: message.text,
            ts: message.ts,
        }));
        messages.push(...messagesJson);
        fs.writeFileSync('channel_messages.json', JSON.stringify(messagesJson, null, 2));
        console.log('Messages saved to channel_messages.json');
        return messagesJson;
    } catch (error) {
        console.error('Error fetching channel messages:', error);
    }
}

// Vectorize JSON data using Gemini Embedding
async function vectorizeJSON(jsonData) {
    const geminiEmbedding = new GeminiEmbedding({
        model: process.env.EMBEDDING_MODEL,
        apiKey: process.env.GOOGLE_API_KEY,
        
    });

    console.log(jsonData)
    const jsonDataText = jsonData.map(x => x.text)
    const jsonDataVector = jsonDataText.map(text => geminiEmbedding.getTextEmbedding(text));
    const vectors = await Promise.all(jsonDataVector)
    
    console.log(vectors);
    PineconeVectors.push(vectors);

    console.log(PineconeVectors[0]);
    return vectors;
}

// Upload vectors to Pinecone
async function uploadVectorsToPinecone(vectors, messages) {
    try {
        const pc = new Pinecone(
             { 
                apiKey: process.env.PINECONE_API_KEY 
            
            });
        const index = pc.index(process.env.VECTOR_DATABASE_INDEX_NAME);

        const upsertData = vectors.map((vector, idx) => ({
            id: `msg_${idx}`,
            values: vector,
            metadata: {
                timestamp: messages[idx]?.ts || new Date().toISOString(),
                user: messages[idx]?.user || 'unknown',
                text: messages[idx]?.text || '',
            }
        }));

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

// This function will run all the above steps
export async function runAll() {
    try {
        await getChannelNames();
        const channelId = await getChannelIdByName("all-new-workspace");
        const channelMessages = await getMessagesFromChannel(channelId);
        const vectors = await vectorizeJSON(messages);
        await uploadVectorsToPinecone(PineconeVectors[0], channelMessages);
    } catch (error) {
        console.error('Error in runAll:', error);
    }
}
