/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { GoogleGenAI, Type } from '@google/genai';
import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import ReactDOM from 'react-dom/client';
import { io, Socket } from 'socket.io-client';

// --- Types ---
type User = {
  id: string;
  name: string;
  avatar?: string;
  email: string;
  about?: string;
};

type AppSettings = {
  theme: 'light' | 'dark';
  color: 'blue' | 'green' | 'purple' | 'orange';
  fontSize: 'small' | 'medium' | 'large';
  notifications: boolean;
  readReceipts: boolean;
};

type Message = {
  id: string;
  senderId: string;
  content: string; // Text content, Audio URL, Image Base64, or File Base64
  type: 'text' | 'audio' | 'image' | 'file';
  fileName?: string; // Only for files
  timestamp: number;
  status: 'sent' | 'delivered' | 'read';
};

type Chat = {
  id: string;
  contactName: string;
  contactAvatar: string; // Emoji or URL
  isAi: boolean;
  isGroup?: boolean;
  participants?: string[];
  systemInstruction?: string;
  messages: Message[];
  lastMessage?: string;
  lastMessageTime?: number;
};

type CallLog = {
  id: string;
  contactId: string;
  contactName: string;
  contactAvatar: string;
  type: 'audio' | 'video';
  direction: 'incoming' | 'outgoing';
  status: 'missed' | 'completed';
  timestamp: number;
  duration?: number; // seconds
};

type StatusUpdate = {
  id: string;
  userId: string;
  userName: string;
  content: string;
  timestamp: number;
};

type CallParticipant = {
  id: string;
  name: string;
  stream?: MediaStream;
  isLocal: boolean;
};

type NewsArticle = {
  headline: string;
  summary: string;
  source: string;
  time: string;
};

// --- SIMULATED INFRASTRUCTURE ---

// 1. Mock Redis (Key-Value + Pub/Sub)
class MockRedis {
  private data: Map<string, any> = new Map();
  private subscribers: Map<string, Function[]> = new Map();

  constructor() {
    console.log("[Redis] Initialized.");
  }

  // Key-Value with TTL
  set(key: string, value: any, ttlSeconds?: number) {
    this.data.set(key, value);
    if (ttlSeconds) {
      setTimeout(() => {
        this.data.delete(key);
      }, ttlSeconds * 1000);
    }
  }

  get(key: string): any {
    return this.data.get(key);
  }

  // Pub/Sub
  subscribe(channel: string, callback: Function) {
    if (!this.subscribers.has(channel)) {
      this.subscribers.set(channel, []);
    }
    this.subscribers.get(channel)?.push(callback);
    console.log(`[Redis] Subscribed to channel: ${channel}`);
  }

  publish(channel: string, message: any) {
    // console.log(`[Redis] Publish to ${channel}:`, message);
    if (this.subscribers.has(channel)) {
      this.subscribers.get(channel)?.forEach(cb => cb(message));
    }
  }
}

// 2. Token Bucket Rate Limiter (Uses Redis)
class TokenBucketLimiter {
  private redis: MockRedis;
  private capacity: number;
  private fillRate: number; // tokens per second

  constructor(redis: MockRedis, capacity: number = 5, fillRate: number = 1) {
    this.redis = redis;
    this.capacity = capacity;
    this.fillRate = fillRate;
  }

  // Returns true if allowed, false if limited
  consume(key: string, tokens: number = 1): boolean {
    const now = Date.now();
    const bucketKey = `ratelimit:${key}`;
    
    let bucket = this.redis.get(bucketKey);
    
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefill: now };
    }

    // Refill logic
    const timePassed = (now - bucket.lastRefill) / 1000;
    const tokensToAdd = timePassed * this.fillRate;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;

    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens;
      this.redis.set(bucketKey, bucket, 60); // Keep alive for a minute
      return true;
    } else {
      this.redis.set(bucketKey, bucket, 60);
      return false;
    }
  }
}

// 3. Mock RabbitMQ (Message Broker)
class MockRabbitMQ {
  private queues: Map<string, Function[]> = new Map();

  constructor() {
    console.log("[RabbitMQ] Broker Started.");
  }

  // Exchange Logic (Direct routing for simplicity)
  publish(routingKey: string, message: any) {
    console.log(`[RabbitMQ] Received msg for routingKey: ${routingKey}`);
    
    // Simulate broker processing delay
    setTimeout(() => {
      if (this.queues.has(routingKey)) {
        const consumers = this.queues.get(routingKey);
        consumers?.forEach(callback => callback(message));
      }
    }, 50);
  }

  consume(queueName: string, callback: Function) {
    if (!this.queues.has(queueName)) {
      this.queues.set(queueName, []);
    }
    this.queues.get(queueName)?.push(callback);
    console.log(`[RabbitMQ] Consumer attached to queue: ${queueName}`);
  }
}

// 4. Mock Backend Server Instance (Socket Service)
// This simulates a single Node.js process
class MockSocketServerInstance {
  id: string;
  private redis: MockRedis;
  private rabbit: MockRabbitMQ;
  private rateLimiter: TokenBucketLimiter;
  private callbacks: {[key: string]: ((data: any) => void)[]} = {};

  constructor(id: string, redis: MockRedis, rabbit: MockRabbitMQ) {
    this.id = id;
    this.redis = redis;
    this.rabbit = rabbit;
    this.rateLimiter = new TokenBucketLimiter(redis, 5, 0.5); // 5 tokens, 1 refill every 2s

    // Subscribe to Redis Pub/Sub for syncing messages across instances
    this.redis.subscribe('global_chat_events', (data: any) => {
       // When Redis tells us there's a new message, we verify if our connected client needs it
       if (data.type === 'new_message') {
           this.emitLocal('message', data.payload);
       }
    });

    // Start RabbitMQ Worker for this instance
    this.rabbit.consume('chat_messages', (msg: any) => {
        // Worker Process: Save to DB (mock) then Broadcast via Redis
        // console.log(`[Server ${this.id}] Worker processing message...`);
        this.redis.publish('global_chat_events', { type: 'new_message', payload: msg });
    });
  }

  // Client connection handler
  connect() {
    console.log(`[Server ${this.id}] Client connected.`);
    setTimeout(() => {
        this.emitLocal('connect', { serverId: this.id });
    }, 100);
    return this;
  }

  // Simulating Client emitting an event to this server
  clientEmit(event: string, data: any, onError: (err: string) => void) {
      if (event === 'message') {
          // 1. Check Rate Limit via Redis Token Bucket
          if (!this.rateLimiter.consume('user_me')) {
              console.warn(`[Server ${this.id}] Rate Limit Exceeded for user_me`);
              onError("Rate limit exceeded. Please wait.");
              return;
          }

          // 2. Publish to RabbitMQ (Decoupling)
          // console.log(`[Server ${this.id}] Enqueueing message to RabbitMQ...`);
          this.rabbit.publish('chat_messages', data.message);
      } else if (event === 'join-room') {
          // Direct handling for SFU signaling for demo
          setTimeout(() => {
              this.emitLocal('new-peer', { id: 'peer_2', name: 'Simulated User' });
          }, 2000);
      }
  }

  // Listener registration
  on(event: string, callback: (data: any) => void) {
    if (!this.callbacks[event]) this.callbacks[event] = [];
    this.callbacks[event].push(callback);
  }

  off(event: string) {
     delete this.callbacks[event];
  }

  private emitLocal(event: string, data: any) {
    if (this.callbacks[event]) {
        this.callbacks[event].forEach(cb => cb(data));
    }
  }
}

// 5. Mock Nginx (Load Balancer)
class MockNginx {
  private servers: MockSocketServerInstance[];
  private currentIndex = 0;

  constructor(servers: MockSocketServerInstance[]) {
    this.servers = servers;
  }

  // Round Robin Strategy
  getClientConnection() {
    const server = this.servers[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.servers.length;
    console.log(`[Nginx] Routing connection to Upstream Server: ${server.id}`);
    return server.connect();
  }
}

// SFU Client Architecture
class SFUClient {
  socket: MockSocketServerInstance;
  peers: Map<string, RTCPeerConnection> = new Map();
  localStream: MediaStream | null = null;
  onTrack: ((stream: MediaStream, peerId: string) => void) | null = null;

  constructor(socket: MockSocketServerInstance) {
    this.socket = socket;
    
    // Listen for new peers (Simulated SFU Signal)
    this.socket.on('new-peer', async (data: { id: string, name: string }) => {
        console.log(`[SFU] New peer joined: ${data.name}`);
        if (this.onTrack && this.localStream) {
             const remoteStream = this.localStream.clone(); 
             this.onTrack(remoteStream, data.id);
        }
    });
  }

  join(roomId: string, stream: MediaStream) {
    this.localStream = stream;
    this.socket.clientEmit('join-room', { roomId }, (err) => console.error(err));
  }

  leave() {
    this.localStream = null;
    this.peers.clear();
  }
}


// --- Simulated Backend Services (Mocking Firebase/Auth.js) ---

// 1. Mock Auth Service
const mockUser: User = {
  id: 'user_me',
  name: 'You',
  email: 'me@example.com',
  about: 'Available',
};

// 2. Mock Database / Storage Service
class MockDB {
  private static STORAGE_KEY = 'willow_app_data_v3';
  private static USER_KEY = 'willow_user_data_v1';
  private static STATUS_KEY = 'willow_status_data_v1';
  private static SETTINGS_KEY = 'willow_settings_v1';
  private static CALLS_KEY = 'willow_call_history_v1';

  static loadUser(): User {
    const stored = localStorage.getItem(this.USER_KEY);
    return stored ? JSON.parse(stored) : mockUser;
  }

  static saveUser(user: User) {
    localStorage.setItem(this.USER_KEY, JSON.stringify(user));
  }

  static loadSettings(): AppSettings {
    const stored = localStorage.getItem(this.SETTINGS_KEY);
    return stored ? JSON.parse(stored) : { 
        theme: 'light', 
        color: 'blue', 
        fontSize: 'medium',
        notifications: true,
        readReceipts: true
    };
  }

  static saveSettings(settings: AppSettings) {
    localStorage.setItem(this.SETTINGS_KEY, JSON.stringify(settings));
  }

  static loadChats(): Chat[] {
    const stored = localStorage.getItem(this.STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
    // Default initial state if empty
    return [
      {
        id: 'c1',
        contactName: 'Willow AI',
        contactAvatar: '✨',
        isAi: true,
        systemInstruction: 'You are Willow, a friendly, intelligent, and witty AI assistant in a blue-themed messaging app. You use emojis often. Keep replies concise like a text message.',
        messages: [
          {
            id: 'm1',
            senderId: 'willow_ai',
            content: 'Hi there! Welcome to Willow. How can I help you today? 💙',
            type: 'text',
            timestamp: Date.now(),
            status: 'read'
          }
        ],
        lastMessage: 'Hi there! Welcome to Willow. How can I help you today? 💙',
        lastMessageTime: Date.now(),
      },
      {
        id: 'c2',
        contactName: 'Chef Mario',
        contactAvatar: '👨‍🍳',
        isAi: true,
        systemInstruction: 'You are Chef Mario. You speak with a passionate Italian flair. You love talking about food, recipes, and ingredients. Keep it short.',
        messages: [],
        lastMessage: '',
        lastMessageTime: 0,
      }
    ];
  }

  static saveChats(chats: Chat[]) {
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(chats));
  }

  static loadStatuses(): StatusUpdate[] {
      const stored = localStorage.getItem(this.STATUS_KEY);
      return stored ? JSON.parse(stored) : [
          { id: 's1', userId: 'willow_ai', userName: 'Willow AI', content: 'Feeling blue in a good way! 💙', timestamp: Date.now() - 3600000 }
      ];
  }

  static saveStatuses(statuses: StatusUpdate[]) {
      localStorage.setItem(this.STATUS_KEY, JSON.stringify(statuses));
  }

  static loadCallHistory(): CallLog[] {
    const stored = localStorage.getItem(this.CALLS_KEY);
    if(stored) return JSON.parse(stored);
    // Mock data for initial view
    return [
      { id: 'cl1', contactId: 'c1', contactName: 'Willow AI', contactAvatar: '✨', type: 'video', direction: 'incoming', status: 'missed', timestamp: Date.now() - 86400000 },
      { id: 'cl2', contactId: 'c2', contactName: 'Chef Mario', contactAvatar: '👨‍🍳', type: 'audio', direction: 'outgoing', status: 'completed', timestamp: Date.now() - 172800000, duration: 125 }
    ];
 }

 static saveCallHistory(history: CallLog[]) {
    localStorage.setItem(this.CALLS_KEY, JSON.stringify(history));
 }
}

// --- Icons Components ---
const Icon = ({ name, className = "", style }: { name: string, className?: string, style?: React.CSSProperties }) => (
  <span className={`material-icons-round ${className}`} style={style}>{name}</span>
);

// --- Audio Message Component ---
const AudioMessage = ({ src, isOut }: { src: string, isOut: boolean }) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  return (
    <div className={`audio-controls ${isOut ? 'text-white' : 'text-gray-800'}`}>
      <audio 
        ref={audioRef} 
        src={src} 
        onEnded={() => setIsPlaying(false)} 
        onPause={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
      />
      <button className="play-btn" onClick={togglePlay}>
        <Icon name={isPlaying ? "pause" : "play_arrow"} />
      </button>
      <div className="waveform">
        <div className={`waveform-progress ${isPlaying ? 'animate-pulse' : ''}`} style={{ width: isPlaying ? '100%' : '0%' }}></div>
      </div>
    </div>
  );
};

// --- Main App Component ---
function App() {
  const [currentUser, setCurrentUser] = useState<User>(MockDB.loadUser());
  const [settings, setSettings] = useState<AppSettings>(MockDB.loadSettings());
  const [chats, setChats] = useState<Chat[]>([]);
  const [callHistory, setCallHistory] = useState<CallLog[]>(MockDB.loadCallHistory());
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [toastMessage, setToastMessage] = useState<{text: string, type: 'error' | 'info'} | null>(null);
  
  // Navigation State
  const [activeTab, setActiveTab] = useState<'chats' | 'calls' | 'status' | 'news' | 'settings'>('chats');
  
  // News State
  const [newsSource, setNewsSource] = useState<'CNN' | 'BBC' | 'Al Jazeera'>('BBC');
  const [newsArticles, setNewsArticles] = useState<NewsArticle[]>([]);
  const [isFetchingNews, setIsFetchingNews] = useState(false);

  // Modals State
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [createMode, setCreateMode] = useState<'ai' | 'group' | null>(null);
  const [newChatName, setNewChatName] = useState('');
  const [newChatAvatar, setNewChatAvatar] = useState('');
  const [newAiInstruction, setNewAiInstruction] = useState('');

  // Voice Recording State
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  // Status State
  const [statuses, setStatuses] = useState<StatusUpdate[]>([]);

  // Call / WebRTC State
  const [isCallActive, setIsCallActive] = useState(false);
  const [callType, setCallType] = useState<'audio' | 'video'>('video');
  const [callParticipants, setCallParticipants] = useState<CallParticipant[]>([]);
  const callStartTimeRef = useRef<number>(0);
  
  // New UI Features State
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showAttachmentMenu, setShowAttachmentMenu] = useState(false);
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  
  // File References
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const cameraVideoRef = useRef<HTMLVideoElement>(null);

  // Infrastructure Initialization
  const infrastructure = useMemo(() => {
    // 1. Redis
    const redis = new MockRedis();
    // 2. RabbitMQ
    const rabbit = new MockRabbitMQ();
    // 3. Servers
    const server1 = new MockSocketServerInstance("srv-01", redis, rabbit);
    const server2 = new MockSocketServerInstance("srv-02", redis, rabbit);
    // 4. Nginx Load Balancer
    const nginx = new MockNginx([server1, server2]);
    
    // Connect client
    const activeConnection = nginx.getClientConnection();
    
    return { redis, rabbit, socket: activeConnection };
  }, []);

  const sfuClient = useMemo(() => new SFUClient(infrastructure.socket), [infrastructure]);
  
  // Gemini Client
  const aiClient = useMemo(() => new GoogleGenAI({ apiKey: process.env.API_KEY }), []);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Apply Settings to DOM
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', settings.theme);
    root.setAttribute('data-color', settings.color);
    root.setAttribute('data-font', settings.fontSize);
    MockDB.saveSettings(settings);
  }, [settings]);

  // Load Data on Mount
  useEffect(() => {
    setChats(MockDB.loadChats());
    setStatuses(MockDB.loadStatuses());
    setCallHistory(MockDB.loadCallHistory());
    
    // Setup Socket Listeners
    infrastructure.socket.on('message', (msg: Message) => {
        if (msg.senderId !== currentUser.id) {
           console.log("Received socket message", msg);
        }
    });

    // SFU Track Handler
    sfuClient.onTrack = (stream, peerId) => {
        setCallParticipants(prev => [
            ...prev, 
            { id: peerId, name: 'Remote User', stream, isLocal: false }
        ]);
    };

    return () => {
        // cleanup
    }
  }, [currentUser.id, infrastructure, sfuClient]);

  // Save Data on Change
  useEffect(() => {
    if (chats.length > 0) MockDB.saveChats(chats);
  }, [chats]);

  useEffect(() => {
    if (statuses.length > 0) MockDB.saveStatuses(statuses);
  }, [statuses]);
  
  useEffect(() => {
    MockDB.saveCallHistory(callHistory);
  }, [callHistory]);

  useEffect(() => {
      MockDB.saveUser(currentUser);
  }, [currentUser]);

  // Fetch News
  useEffect(() => {
      if (activeTab === 'news') {
          fetchNews();
      }
  }, [activeTab, newsSource]);

  // Camera initialization when open
  useEffect(() => {
      let stream: MediaStream | null = null;
      if (isCameraOpen) {
          navigator.mediaDevices.getUserMedia({ video: true })
            .then(s => {
                stream = s;
                if (cameraVideoRef.current) {
                    cameraVideoRef.current.srcObject = stream;
                }
            })
            .catch(err => {
                console.error("Camera error", err);
                showToast("Could not access camera", 'error');
                setIsCameraOpen(false);
            });
      }
      return () => {
          if (stream) stream.getTracks().forEach(t => t.stop());
      };
  }, [isCameraOpen]);

  const fetchNews = async () => {
      setIsFetchingNews(true);
      try {
          const response = await aiClient.models.generateContent({
              model: 'gemini-3-flash-preview',
              contents: `Generate 4 realistic breaking news headlines and short 2-sentence summaries as if they were currently on ${newsSource}. Return valid JSON array with keys: headline, summary, time (e.g., '2h ago').`,
              config: {
                  responseMimeType: 'application/json',
                  responseSchema: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        headline: { type: Type.STRING },
                        summary: { type: Type.STRING },
                        time: { type: Type.STRING }
                      }
                    }
                  }
              }
          });
          const data = JSON.parse(response.text || '[]');
          setNewsArticles(data.map((a: any) => ({ ...a, source: newsSource })));
      } catch (e) {
          console.error("Failed to fetch news", e);
      } finally {
          setIsFetchingNews(false);
      }
  };

  // Scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chats, activeChatId, isTyping]);

  const activeChat = useMemo(() => 
    chats.find((c) => c.id === activeChatId), 
  [chats, activeChatId]);

  const showToast = (text: string, type: 'error' | 'info') => {
      setToastMessage({ text, type });
      setTimeout(() => setToastMessage(null), 3000);
  };

  // --- Creation Logic ---
  const handleCreateChat = () => {
      if (createMode === 'ai') {
          const newChat: Chat = {
              id: 'ai_' + Date.now(),
              contactName: newChatName || 'New AI',
              contactAvatar: newChatAvatar || '🤖',
              isAi: true,
              systemInstruction: newAiInstruction || 'You are a helpful assistant.',
              messages: [],
              lastMessage: '',
              lastMessageTime: Date.now()
          };
          setChats([newChat, ...chats]);
      } else if (createMode === 'group') {
           const newChat: Chat = {
              id: 'gp_' + Date.now(),
              contactName: newChatName || 'New Group',
              contactAvatar: '👥',
              isAi: false,
              isGroup: true,
              participants: ['user_me', 'willow_ai'], 
              messages: [{
                  id: 'sys_' + Date.now(),
                  senderId: 'system',
                  content: 'Group created',
                  type: 'text',
                  timestamp: Date.now(),
                  status: 'read'
              }],
              lastMessage: 'Group created',
              lastMessageTime: Date.now()
          };
          setChats([newChat, ...chats]);
      }
      setShowCreateModal(false);
      setNewChatName('');
      setNewChatAvatar('');
      setNewAiInstruction('');
      setCreateMode(null);
  };

  // --- Voice Recording ---
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      const audioChunks: Blob[] = [];

      mediaRecorder.ondataavailable = (event) => {
        audioChunks.push(event.data);
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
        const audioUrl = URL.createObjectURL(audioBlob);
        sendMessage(audioUrl, 'audio');
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error("Error accessing microphone:", err);
      alert("Microphone access denied or not available.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop()); // Stop mic usage
      setIsRecording(false);
    }
  };

  // --- Messaging ---
  const sendMessage = async (content: string, type: Message['type'], fileName?: string) => {
    if (!activeChatId) return;
    if (type === 'text' && !content.trim()) return;

    const newMessage: Message = {
      id: Date.now().toString(),
      senderId: currentUser.id,
      content: content,
      type: type,
      fileName: fileName,
      timestamp: Date.now(),
      status: 'sent',
    };

    infrastructure.socket.clientEmit('message', { chatId: activeChatId, message: newMessage }, (errorMsg) => {
        showToast(errorMsg, 'error');
    });

    const updatedChats = chats.map((chat) => {
      if (chat.id === activeChatId) {
        let previewText = '';
        if (type === 'text') previewText = newMessage.content;
        else if (type === 'audio') previewText = '🎤 Voice Message';
        else if (type === 'image') previewText = '📷 Photo';
        else if (type === 'file') previewText = '📄 File';

        return {
          ...chat,
          messages: [...chat.messages, newMessage],
          lastMessage: previewText,
          lastMessageTime: newMessage.timestamp,
        };
      }
      return chat;
    });

    setChats(updatedChats);
    setInputText('');
    setShowEmojiPicker(false);
    setShowAttachmentMenu(false);

    // Trigger AI Response if it's an AI chat
    const currentChat = updatedChats.find(c => c.id === activeChatId);
    if (currentChat?.isAi && type === 'text') {
      setIsTyping(true);
      try {
        await generateAiResponse(currentChat);
      } catch (error) {
        console.error("Error generating AI response:", error);
        setIsTyping(false);
      }
    } else if (currentChat?.isAi && (type === 'audio' || type === 'image' || type === 'file')) {
        setTimeout(() => {
             const autoReply: Message = {
                id: Date.now().toString(),
                senderId: currentChat.id,
                content: `I received your ${type}! (I can't analyze files yet, but I see it!)`,
                type: 'text',
                timestamp: Date.now(),
                status: 'read'
             }
             setChats(prev => prev.map(c => c.id === currentChat.id ? {...c, messages: [...c.messages, autoReply]} : c));
        }, 1500);
    }
  };

  const generateAiResponse = async (chat: Chat) => {
    const history = chat.messages
      .filter(m => m.type === 'text')
      .slice(-10)
      .map(m => ({
        role: m.senderId === currentUser.id ? 'user' : 'model',
        parts: [{ text: m.content }],
      }));
    
    if (history.length === 0) return;
    const lastMsg = history[history.length - 1];
    let sessionHistory = history.slice(0, -1);

    while (sessionHistory.length > 0 && sessionHistory[0].role !== 'user') {
      sessionHistory.shift();
    }

    try {
      const chatSession = aiClient.chats.create({
        model: 'gemini-3-flash-preview',
        config: { systemInstruction: chat.systemInstruction },
        history: sessionHistory,
      });

      const result = await chatSession.sendMessage({ message: lastMsg.parts[0].text });
      const responseText = result.text;

      const aiMessage: Message = {
        id: (Date.now() + 1).toString(),
        senderId: chat.id,
        content: responseText || '',
        type: 'text',
        timestamp: Date.now(),
        status: 'read',
      };

      setChats(prev => prev.map(c => {
        if (c.id === chat.id) {
          return {
            ...c,
            messages: [...c.messages, aiMessage],
            lastMessage: aiMessage.content,
            lastMessageTime: aiMessage.timestamp
          };
        }
        return c;
      }));
    } catch (e) {
      console.error(e);
    } finally {
      setIsTyping(false);
    }
  };

  // --- File Handlers ---
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>, type: 'file' | 'image') => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
          if (event.target?.result) {
              const base64 = event.target.result as string;
              sendMessage(base64, type, file.name);
          }
      };
      reader.readAsDataURL(file);
  };

  const handleCapturePhoto = () => {
      if (!cameraVideoRef.current) return;
      const canvas = document.createElement('canvas');
      canvas.width = cameraVideoRef.current.videoWidth;
      canvas.height = cameraVideoRef.current.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
          // Flip horizontally to match video mirror effect
          ctx.translate(canvas.width, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(cameraVideoRef.current, 0, 0);
          
          const base64 = canvas.toDataURL('image/jpeg');
          sendMessage(base64, 'image');
          setIsCameraOpen(false);
      }
  };

  // --- WebRTC / SFU Logic ---
  const startCall = async (type: 'audio' | 'video') => {
      if (!activeChat) return;
      
      try {
          const stream = await navigator.mediaDevices.getUserMedia({ 
              video: type === 'video', 
              audio: true 
          });
          
          setIsCallActive(true);
          setCallType(type);
          callStartTimeRef.current = Date.now();
          
          // Add local participant
          setCallParticipants([{
              id: 'local',
              name: 'You',
              stream: stream,
              isLocal: true
          }]);

          // Join SFU Room
          sfuClient.join(activeChat.id, stream);

      } catch (err) {
          console.error("Camera/Mic permission failed", err);
          alert("Permission needed for calling.");
      }
  };

  const endCall = () => {
      // Log Call
      if (activeChat) {
          const duration = Math.round((Date.now() - callStartTimeRef.current) / 1000);
          const newLog: CallLog = {
               id: Date.now().toString(),
               contactId: activeChat.id,
               contactName: activeChat.contactName,
               contactAvatar: activeChat.contactAvatar,
               type: callType,
               direction: 'outgoing',
               status: 'completed',
               timestamp: Date.now(),
               duration: duration
          };
          setCallHistory(prev => [newLog, ...prev]);
      }

      // Cleanup streams
      callParticipants.forEach(p => {
          if (p.isLocal && p.stream) {
              p.stream.getTracks().forEach(t => t.stop());
          }
      });
      sfuClient.leave();
      setCallParticipants([]);
      setIsCallActive(false);
  };
  
  // Helper to attach stream to video element
  const VideoElement = ({ participant }: { participant: CallParticipant }) => {
      const videoRef = useRef<HTMLVideoElement>(null);
      useEffect(() => {
          if (videoRef.current && participant.stream) {
              videoRef.current.srcObject = participant.stream;
          }
      }, [participant.stream]);

      return (
          <div className="video-tile">
             <video ref={videoRef} autoPlay muted={participant.isLocal} playsInline className="video-element" />
             <div className="video-label">{participant.name} {participant.isLocal ? '(You)' : ''}</div>
          </div>
      );
  }

  // --- Render Helpers ---

  const renderSidebarContent = () => {
      if (activeTab === 'chats') {
          const filteredChats = chats.filter(c => 
            c.contactName.toLowerCase().includes(searchTerm.toLowerCase())
          ).sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));

          return (
             <div className="sidebar-content">
                <div className="chat-list">
                    {filteredChats.map(chat => (
                        <div 
                        key={chat.id} 
                        className={`chat-item ${activeChatId === chat.id ? 'active' : ''}`}
                        onClick={() => {
                            setActiveChatId(chat.id);
                        }}
                        >
                        <div className="user-avatar" style={{backgroundColor: '#E5E7EB'}}>
                            <span style={{fontSize: '1.5rem'}}>{chat.contactAvatar}</span>
                        </div>
                        <div className="chat-info">
                            <div className="chat-name-row">
                            <span className="chat-name">{chat.contactName}</span>
                            <span className="chat-time">
                                {chat.lastMessageTime ? new Date(chat.lastMessageTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : ''}
                            </span>
                            </div>
                            <div className="chat-preview-row">
                            <span className="chat-preview">
                                {chat.lastMessage || 'Start a conversation'}
                            </span>
                            </div>
                        </div>
                        </div>
                    ))}
                </div>
                <button className="fab" onClick={() => setShowCreateModal(true)}>
                    <Icon name="add" />
                </button>
            </div>
          );
      }

      if (activeTab === 'calls') {
          return (
              <div className="sidebar-content">
                   <div className="status-header" style={{padding: '16px 16px 0'}}>Call History</div>
                   {callHistory.length === 0 && (
                       <div style={{padding: 20, textAlign: 'center', color: 'var(--text-secondary)'}}>No calls yet</div>
                   )}
                   {callHistory.map(log => (
                     <div key={log.id} className="chat-item" style={{cursor: 'default'}}>
                        <div className="user-avatar" style={{backgroundColor: '#E5E7EB'}}>
                            <span style={{fontSize: '1.5rem'}}>{log.contactAvatar}</span>
                        </div>
                        <div className="chat-info">
                           <div className="chat-name-row">
                              <span className="chat-name" style={{color: log.status === 'missed' ? '#ef4444' : 'var(--text-primary)'}}>{log.contactName}</span>
                           </div>
                           <div className="chat-preview-row" style={{alignItems:'center', gap: 6}}>
                              <Icon name={log.direction === 'outgoing' ? 'call_made' : 'call_received'} 
                                    style={{fontSize: 14, color: log.status === 'missed' ? '#ef4444' : (log.direction === 'outgoing' ? '#22c55e' : 'var(--primary-color)')}} />
                              <span className="chat-preview">
                                {new Date(log.timestamp).toLocaleString(undefined, {weekday: 'short', hour: 'numeric', minute: '2-digit'})}
                              </span>
                           </div>
                        </div>
                        <div>
                           <Icon name={log.type === 'video' ? 'videocam' : 'call'} style={{color: 'var(--primary-color)'}} />
                        </div>
                     </div>
                   ))}
              </div>
          )
      }

      if (activeTab === 'news') {
          return (
              <div className="sidebar-content news-view">
                  <div className="news-filters">
                      {['CNN', 'BBC', 'Al Jazeera'].map(source => (
                          <div 
                             key={source}
                             className={`news-chip ${newsSource === source ? 'active' : ''}`}
                             onClick={() => setNewsSource(source as any)}
                          >
                              {source}
                          </div>
                      ))}
                  </div>
                  
                  {isFetchingNews ? (
                      <div style={{textAlign: 'center', padding: 20}}>
                          <div className="dot" style={{display: 'inline-block', margin: 2}}></div>
                          <div className="dot" style={{display: 'inline-block', margin: 2}}></div>
                          <div className="dot" style={{display: 'inline-block', margin: 2}}></div>
                      </div>
                  ) : (
                      newsArticles.map((article, i) => (
                          <div key={i} className="news-card">
                              <div className="news-source">{article.source} • {article.time}</div>
                              <div className="news-headline">{article.headline}</div>
                              <div className="news-summary">{article.summary}</div>
                          </div>
                      ))
                  )}
              </div>
          );
      }

      if (activeTab === 'status') {
          return (
              <div className="sidebar-content status-section">
                  <div className="status-header">My Status</div>
                  <div className="status-item">
                      <div className="user-avatar status-avatar-ring">
                        {currentUser.name[0]}
                      </div>
                      <div>
                          <div style={{fontWeight: 500}}>My Status</div>
                          <div style={{fontSize: '0.8rem', color: '#6B7280'}}>Tap to add status update</div>
                      </div>
                  </div>
                  
                  <div className="status-header" style={{marginTop: 24}}>Recent Updates</div>
                  {statuses.map(status => (
                      <div key={status.id} className="status-item">
                          <div className="user-avatar status-avatar-ring" style={{backgroundColor: '#E5E7EB', color: '#000'}}>
                              {status.userName[0]}
                          </div>
                          <div>
                              <div style={{fontWeight: 500}}>{status.userName}</div>
                              <div style={{fontSize: '0.8rem', color: '#6B7280'}}>{status.content}</div>
                          </div>
                      </div>
                  ))}

                  <div className="status-input-area">
                       <input 
                         type="text" 
                         className="profile-input" 
                         placeholder="Add a new status..."
                         onKeyDown={(e) => {
                             if(e.key === 'Enter') {
                                 const val = e.currentTarget.value;
                                 if(!val.trim()) return;
                                 const newStatus: StatusUpdate = {
                                     id: Date.now().toString(),
                                     userId: currentUser.id,
                                     userName: currentUser.name,
                                     content: val,
                                     timestamp: Date.now()
                                 };
                                 setStatuses([newStatus, ...statuses]);
                                 e.currentTarget.value = '';
                             }
                         }}
                       />
                  </div>
              </div>
          )
      }

      if (activeTab === 'settings') {
          return (
              <div className="sidebar-content settings-view">
                  <div className="settings-header">
                      <div className="user-avatar" style={{width: 60, height: 60, fontSize: '1.5rem'}}>
                          {currentUser.name[0]}
                      </div>
                      <div>
                          <div style={{fontWeight: 600, fontSize: '1.2rem'}}>{currentUser.name}</div>
                          <div style={{color: '#6B7280', fontSize: '0.9rem'}}>{currentUser.about}</div>
                      </div>
                  </div>

                  <div className="settings-group">
                      <div className="settings-group-title">App Settings</div>
                      <div className="settings-item" onClick={() => setShowSettingsModal(true)}>
                          <Icon name="tune" /> Chat Settings
                      </div>
                  </div>
                  
                  <div className="settings-group">
                      <div className="settings-group-title">Account</div>
                      <div className="settings-item">
                          <Icon name="key" /> Privacy
                      </div>
                      <div className="settings-item">
                          <Icon name="security" /> Security
                      </div>
                      <div className="settings-item">
                          <Icon name="verified_user" /> Two-Step Verification
                      </div>
                  </div>

                  <div className="settings-group">
                      <div className="settings-group-title">App</div>
                      <div className="settings-item">
                          <Icon name="notifications" /> Notifications
                      </div>
                      <div className="settings-item">
                          <Icon name="data_usage" /> Storage and Data
                      </div>
                      <div className="settings-item">
                          <Icon name="language" /> App Language
                      </div>
                      <div className="settings-item">
                          <Icon name="help" /> Help
                      </div>
                  </div>
              </div>
          )
      }
  };

  return (
    <div className="willow-app">
      {/* --- Toast Notifications --- */}
      {toastMessage && (
          <div className="toast-container">
              <div className={`toast ${toastMessage.type}`}>
                  <Icon name={toastMessage.type === 'error' ? 'error_outline' : 'info'} />
                  {toastMessage.text}
              </div>
          </div>
      )}

      {/* --- Sidebar --- */}
      <aside className={`sidebar ${activeChatId ? 'hidden md:flex' : 'flex'}`}>
        <header className="sidebar-header">
           <div style={{fontWeight: 700, fontSize: '1.2rem', color: 'var(--primary-color)'}}>Willow</div>
          <div className="sidebar-actions">
            <div className={`nav-tab ${activeTab === 'chats' ? 'active' : ''}`} onClick={() => setActiveTab('chats')} title="Chats">
                <Icon name="chat" />
            </div>
            <div className={`nav-tab ${activeTab === 'calls' ? 'active' : ''}`} onClick={() => setActiveTab('calls')} title="Calls">
                <Icon name="phone" />
            </div>
            <div className={`nav-tab ${activeTab === 'status' ? 'active' : ''}`} onClick={() => setActiveTab('status')} title="Status">
                <Icon name="donut_large" />
            </div>
            <div className={`nav-tab ${activeTab === 'news' ? 'active' : ''}`} onClick={() => setActiveTab('news')} title="News">
                <Icon name="newspaper" />
            </div>
            <div className={`nav-tab ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => setActiveTab('settings')} title="Settings">
                <Icon name="settings" />
            </div>
          </div>
        </header>
        
        {activeTab === 'chats' && (
            <div className="search-bar-container">
            <div className="search-input-wrapper">
                <Icon name="search" className="text-gray-500" />
                <input 
                type="text" 
                placeholder="Search or start new chat" 
                className="search-input"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                />
            </div>
            </div>
        )}

        {renderSidebarContent()}
      </aside>

      {/* --- Chat Window --- */}
      {activeChat && activeTab === 'chats' ? (
        <main className={`chat-window ${!activeChatId ? 'hidden' : 'flex'}`}>
          <header className="chat-header">
            <div className="chat-header-info">
              <button className="icon-btn md:hidden" onClick={() => setActiveChatId(null)}>
                <Icon name="arrow_back" />
              </button>
              <div className="user-avatar" style={{backgroundColor: '#E5E7EB'}}>
                <span style={{fontSize: '1.5rem'}}>{activeChat.contactAvatar}</span>
              </div>
              <div style={{display: 'flex', flexDirection: 'column'}}>
                <span style={{fontWeight: 600}}>{activeChat.contactName}</span>
                <span style={{fontSize: '0.75rem', color: '#6B7280'}}>
                  {isTyping ? 'typing...' : (activeChat.isGroup ? 'Click for group info' : 'Online')}
                </span>
              </div>
            </div>
            <div className="chat-header-actions">
              <button className="icon-btn" onClick={() => startCall('video')}><Icon name="videocam" /></button>
              <button className="icon-btn" onClick={() => startCall('audio')}><Icon name="call" /></button>
              <div style={{width: 1, height: 24, background: '#cbd5e1', margin: '0 8px'}}></div>
              <button className="icon-btn"><Icon name="search" /></button>
              <button className="icon-btn"><Icon name="more_vert" /></button>
            </div>
          </header>

          <div className="messages-area">
            {activeChat.messages.map((msg) => (
              <div 
                key={msg.id} 
                className={`message-bubble ${msg.senderId === currentUser.id ? 'out' : 'in'} ${msg.type === 'audio' ? 'audio' : ''}`}
              >
                {msg.type === 'text' && msg.content}
                
                {msg.type === 'audio' && (
                    <AudioMessage src={msg.content} isOut={msg.senderId === currentUser.id} />
                )}

                {msg.type === 'image' && (
                    <img src={msg.content} alt="Photo" className="message-image" onClick={() => { /* View full screen logic could go here */ }}/>
                )}

                {msg.type === 'file' && (
                    <div className="message-file">
                        <Icon name="description" className="message-file-icon" />
                        <div className="message-file-info">
                            <div className="message-file-name">{msg.fileName || 'Document'}</div>
                            <div className="message-file-size">File Attachment</div>
                        </div>
                    </div>
                )}

                <div className="message-time">
                  {new Date(msg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                  {msg.senderId === currentUser.id && (
                     <Icon name="done_all" className="text-[12px]" />
                  )}
                </div>
              </div>
            ))}
            
            {isTyping && (
              <div className="typing-indicator">
                <div className="dot"></div>
                <div className="dot"></div>
                <div className="dot"></div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="input-area">
             {/* Hidden Inputs */}
             <input type="file" ref={fileInputRef} hidden onChange={(e) => handleFileUpload(e, 'file')} />
             <input type="file" ref={imageInputRef} hidden accept="image/*" onChange={(e) => handleFileUpload(e, 'image')} />
            
             {/* Attachment Menu Popup */}
             {showAttachmentMenu && (
                 <div className="attachment-menu">
                     <div className="attachment-item" onClick={() => { imageInputRef.current?.click(); setShowAttachmentMenu(false); }}>
                         <Icon name="image" style={{color: '#d946ef'}}/> Photos & Videos
                     </div>
                     <div className="attachment-item" onClick={() => { setIsCameraOpen(true); setShowAttachmentMenu(false); }}>
                         <Icon name="camera_alt" style={{color: '#ef4444'}}/> Camera
                     </div>
                     <div className="attachment-item" onClick={() => { fileInputRef.current?.click(); setShowAttachmentMenu(false); }}>
                         <Icon name="description" style={{color: '#3b82f6'}}/> Document
                     </div>
                 </div>
             )}

             {/* Emoji Picker Popup */}
             {showEmojiPicker && (
                 <div className="emoji-picker">
                     {['😀','😂','🥰','😎','🤔','😴','😭','😡','👍','👎','🎉','🔥','👀','✨','💙','🐸','🍕','☕','📅','📍','🤖','👻','💀','👽'].map(emoji => (
                         <div key={emoji} className="emoji-btn" onClick={() => setInputText(prev => prev + emoji)}>{emoji}</div>
                     ))}
                 </div>
             )}

            <button className="icon-btn" onClick={() => { setShowEmojiPicker(!showEmojiPicker); setShowAttachmentMenu(false); }}>
                <Icon name="sentiment_satisfied_alt" />
            </button>
            <button className="icon-btn" onClick={() => { setShowAttachmentMenu(!showAttachmentMenu); setShowEmojiPicker(false); }}>
                <Icon name="attach_file" />
            </button>
            <div className="input-wrapper">
              <input 
                type="text" 
                className="message-input" 
                placeholder="Type a message"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendMessage(inputText, 'text')}
                onFocus={() => { setShowEmojiPicker(false); setShowAttachmentMenu(false); }}
              />
            </div>
            {inputText ? (
              <button className="icon-btn send-btn" onClick={() => sendMessage(inputText, 'text')}>
                <Icon name="send" />
              </button>
            ) : (
              <button 
                className={`icon-btn ${isRecording ? 'record-btn' : ''}`} 
                onClick={isRecording ? stopRecording : startRecording}
                title={isRecording ? "Stop Recording" : "Record Voice Message"}
              >
                <Icon name={isRecording ? "stop_circle" : "mic"} />
              </button>
            )}
          </div>
        </main>
      ) : (
        <div className={`empty-state hidden md:flex ${activeTab !== 'chats' ? 'hidden' : ''}`}>
          <div style={{fontSize: '4rem', color: 'var(--primary-color)', marginBottom: 20}}>
            <Icon name="chat" className="text-6xl" />
          </div>
          <h2 style={{fontWeight: 300, fontSize: '1.8rem', marginBottom: 10}}>Welcome to Willow</h2>
          <p>Send and receive messages without keeping your phone online.</p>
          <p style={{fontSize: '0.85rem', marginTop: 10}}>
            <Icon name="lock" style={{fontSize: 12, verticalAlign: 'middle'}} /> End-to-end simulated encryption
          </p>
        </div>
      )}

      {/* --- Call Overlay (SFU Grid) --- */}
      {isCallActive && (
          <div className="call-overlay">
              <div className="call-header">
                  <div style={{textAlign:'center'}}>
                      <div style={{fontSize: '1.2rem', fontWeight: 600}}>{activeChat?.contactName}</div>
                      <div style={{fontSize: '0.9rem', opacity: 0.8}}>{callType === 'video' ? 'Video' : 'Audio'} Call • {callParticipants.length} Participants</div>
                  </div>
              </div>

              <div className="call-main-grid">
                  {callParticipants.map(participant => (
                      <VideoElement key={participant.id} participant={participant} />
                  ))}
              </div>

              <div className="call-controls">
                  <button className="call-btn"><Icon name="volume_up" /></button>
                  <button className="call-btn"><Icon name={callType === 'video' ? "videocam" : "videocam_off"} /></button>
                  <button className="call-btn"><Icon name="mic" /></button>
                  <button className="call-btn end" onClick={endCall}><Icon name="call_end" /></button>
              </div>
          </div>
      )}

      {/* --- Camera Capture Modal --- */}
      {isCameraOpen && (
          <div className="camera-capture-overlay">
              <div className="camera-capture-view">
                  <video ref={cameraVideoRef} autoPlay playsInline className="camera-video" style={{transform: 'scaleX(-1)'}}></video>
              </div>
              <div className="camera-actions">
                  <button className="camera-close-btn" onClick={() => setIsCameraOpen(false)}>
                      <Icon name="close" />
                  </button>
                  <button className="capture-trigger" onClick={handleCapturePhoto}></button>
                  <div style={{width: 48}}></div> {/* Spacer for balance */}
              </div>
          </div>
      )}

      {/* --- Settings Modal --- */}
      {showSettingsModal && (
        <div className="modal-overlay" onClick={(e) => {if(e.target === e.currentTarget) setShowSettingsModal(false)}}>
          <div className="modal-content">
            <div className="modal-header">Chat Settings</div>
            
            {/* Theme Section */}
            <div style={{marginBottom: 20}}>
              <div className="profile-label">App Theme</div>
              <div style={{display: 'flex', gap: 10}}>
                {['light', 'dark'].map(t => (
                   <button 
                     key={t}
                     className={`btn ${settings.theme === t ? 'btn-primary' : 'btn-secondary'}`}
                     style={{textTransform: 'capitalize', flex: 1}}
                     onClick={() => setSettings({...settings, theme: t as any})}
                   >{t}</button>
                ))}
              </div>
            </div>

            {/* Color Section */}
            <div style={{marginBottom: 20}}>
               <div className="profile-label">Accent Color</div>
               <div style={{display: 'flex', gap: 12}}>
                  {['blue', 'green', 'purple', 'orange'].map(c => (
                    <div 
                      key={c}
                      onClick={() => setSettings({...settings, color: c as any})}
                      style={{
                        width: 32, height: 32, borderRadius: '50%', cursor: 'pointer',
                        backgroundColor: c === 'blue' ? '#2563EB' : c === 'green' ? '#10B981' : c === 'purple' ? '#8B5CF6' : '#F97316',
                        border: settings.color === c ? '3px solid var(--text-primary)' : '1px solid var(--border-color)',
                        transform: settings.color === c ? 'scale(1.1)' : 'scale(1)'
                      }}
                    />
                  ))}
               </div>
            </div>

            {/* Font Size Section */}
             <div style={{marginBottom: 20}}>
              <div className="profile-label">Font Size</div>
              <div style={{display: 'flex', gap: 10}}>
                {['small', 'medium', 'large'].map(s => (
                   <button 
                     key={s}
                     className={`btn ${settings.fontSize === s ? 'btn-primary' : 'btn-secondary'}`}
                     style={{textTransform: 'capitalize', flex: 1}}
                     onClick={() => setSettings({...settings, fontSize: s as any})}
                   >{s}</button>
                ))}
              </div>
            </div>

            {/* Privacy & Notifications */}
            <div style={{marginBottom: 20}}>
              <div className="profile-label">Privacy & Notifications</div>
              <div className="settings-item" style={{justifyContent: 'space-between', borderRadius: 8, marginBottom: 8}} onClick={() => setSettings({...settings, notifications: !settings.notifications})}>
                <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                  <Icon name="notifications" />
                  <span>Notification Sounds</span>
                </div>
                <div className={`toggle-switch ${settings.notifications ? 'active' : ''}`}>
                  <div className="toggle-thumb"></div>
                </div>
              </div>
               <div className="settings-item" style={{justifyContent: 'space-between', borderRadius: 8}} onClick={() => setSettings({...settings, readReceipts: !settings.readReceipts})}>
                <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                  <Icon name="done_all" />
                  <span>Read Receipts</span>
                </div>
                <div className={`toggle-switch ${settings.readReceipts ? 'active' : ''}`}>
                  <div className="toggle-thumb"></div>
                </div>
              </div>
            </div>

            <div className="modal-actions">
              <button className="btn btn-primary" onClick={() => setShowSettingsModal(false)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {/* --- Create Modal --- */}
      {showCreateModal && (
          <div className="modal-overlay" onClick={(e) => {if(e.target === e.currentTarget) setShowCreateModal(false)}}>
              <div className="modal-content">
                  <div className="modal-header">
                      {createMode === 'ai' ? 'Create AI Character' : (createMode === 'group' ? 'New Group' : 'New Chat')}
                  </div>
                  
                  {!createMode && (
                      <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
                          <button className="btn btn-secondary" style={{justifyContent: 'flex-start', display: 'flex', alignItems: 'center', gap: 10}} onClick={() => setCreateMode('ai')}>
                              <Icon name="smart_toy" /> Create Custom AI
                          </button>
                          <button className="btn btn-secondary" style={{justifyContent: 'flex-start', display: 'flex', alignItems: 'center', gap: 10}} onClick={() => setCreateMode('group')}>
                              <Icon name="group_add" /> Create Group
                          </button>
                      </div>
                  )}

                  {createMode === 'ai' && (
                      <div style={{display: 'flex', flexDirection: 'column', gap: 12}}>
                          <input type="text" className="profile-input" placeholder="Character Name (e.g. Yoda)" value={newChatName} onChange={e => setNewChatName(e.target.value)} />
                          <input type="text" className="profile-input" placeholder="Avatar Emoji (e.g. 🐸)" value={newChatAvatar} onChange={e => setNewChatAvatar(e.target.value)} />
                          <textarea className="profile-input" placeholder="Personality / Instructions" rows={3} value={newAiInstruction} onChange={e => setNewAiInstruction(e.target.value)} style={{border:'1px solid #e5e7eb', borderRadius: 4, padding: 8}}></textarea>
                      </div>
                  )}

                  {createMode === 'group' && (
                      <div style={{display: 'flex', flexDirection: 'column', gap: 12}}>
                          <input type="text" className="profile-input" placeholder="Group Name" value={newChatName} onChange={e => setNewChatName(e.target.value)} />
                          <p style={{fontSize: '0.85rem', color: '#666'}}>Participants: You, Willow AI (Default)</p>
                      </div>
                  )}

                  <div className="modal-actions">
                      <button className="btn btn-secondary" onClick={() => {setShowCreateModal(false); setCreateMode(null);}}>Cancel</button>
                      {createMode && <button className="btn btn-primary" onClick={handleCreateChat}>Create</button>}
                  </div>
              </div>
          </div>
      )}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);