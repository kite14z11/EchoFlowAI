import React, { useState, useEffect, useRef } from 'react';
import { 
  Play, 
  Mic, 
  RotateCcw, 
  History, 
  Settings, 
  Send, 
  LogOut, 
  User as UserIcon,
  ChevronRight,
  Sparkles,
  Search,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Volume2,
  Trash2,
  Download
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  signOut,
  User 
} from 'firebase/auth';
import { 
  collection, 
  addDoc, 
  query, 
  where, 
  orderBy, 
  onSnapshot,
  Timestamp,
  serverTimestamp,
  doc,
  getDocFromServer,
  deleteDoc
} from 'firebase/firestore';
import { auth, db } from './lib/firebase';
import { generateSpeech, getSpeechFeedback, getLabItemScore, rewriteSpeechScript } from './lib/gemini';
import { playPcm24k } from './lib/audio';
import * as diff from 'diff';
import { format } from 'date-fns';
import { ja } from 'date-fns/locale';

// --- Types ---
interface PracticeItem {
  text: string;
  type: 'word' | 'phrase';
  reason: string;
  latestScore?: number;
}

interface PracticeSession {
  id?: string;
  userId: string;
  title: string;
  date: string;
  originalText: string;
  transcript: string;
  feedback: string;
  score: number;
  practiceItems?: PracticeItem[];
  voiceSettings: {
    voiceName: string;
    tone: string;
    speed?: number;
  };
  createdAt: any;
}

// --- Constants ---
const VOICES = [
  { name: 'Kore', label: 'Female (Kore)', gender: 'female' },
  { name: 'Fenrir', label: 'Male (Fenrir)', gender: 'male' },
  { name: 'Zephyr', label: 'Male (Zephyr)', gender: 'male' },
  { name: 'Puck', label: 'Male (Puck)', gender: 'male' },
  { name: 'Charon', label: 'Male (Charon)', gender: 'male' },
];

const TONES = [
  { value: 'neutral', label: 'Normal' },
  { value: 'energetic', label: 'Energetic' },
  { value: 'professional speech', label: 'Speech' },
  { value: 'casual conversation', label: 'Casual' },
];

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [inputText, setInputText] = useState('');
  const [title, setTitle] = useState('');
  const [selectedVoice, setSelectedVoice] = useState(() => localStorage.getItem('echoFlow_voice') || 'Kore');
  const [selectedTone, setSelectedTone] = useState(() => localStorage.getItem('echoFlow_tone') || 'neutral');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [feedback, setFeedback] = useState('');
  const [score, setScore] = useState<number | null>(null);
  const [practiceItems, setPracticeItems] = useState<PracticeItem[]>([]);
  const [playbackSpeed, setPlaybackSpeed] = useState(() => {
    const saved = localStorage.getItem('echoFlow_speed');
    return saved ? parseFloat(saved) : 1.0;
  });
  const [labRecordingIndex, setLabRecordingIndex] = useState<number | null>(null);
  const [isLabAnalyzing, setIsLabAnalyzing] = useState<number | null>(null);
  const [history, setHistory] = useState<PracticeSession[]>([]);
  const [activeTab, setActiveTab] = useState<'practice' | 'history' | 'lab'>('practice');
  const [isLoadingFeedback, setIsLoadingFeedback] = useState(false);
  const [isDictatingScript, setIsDictatingScript] = useState(false);
  const [isRewriting, setIsRewriting] = useState<'business' | 'casual' | null>(null);

  // Speech Recognition
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
    });

    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if (error instanceof Error && error.message.includes('permission-denied')) {
          console.log("Firebase connected successfully");
        } else if (error instanceof Error && error.message.includes('offline')) {
          console.error("Please check your Firebase configuration.");
        }
      }
    };
    testConnection();

    return () => unsub();
  }, []);

  useEffect(() => {
    if (user && db) {
      const q = query(
        collection(db, 'sessions'),
        where('userId', '==', user.uid),
        orderBy('createdAt', 'desc')
      );
      const unsub = onSnapshot(q, (snapshot) => {
        const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as PracticeSession));
        // Sort locally to ensure newest at top even when server timestamp is pending
        const sorted = docs.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        setHistory(sorted);
      });
      return () => unsub();
    }
  }, [user]);

  useEffect(() => {
    localStorage.setItem('echoFlow_voice', selectedVoice);
  }, [selectedVoice]);

  useEffect(() => {
    localStorage.setItem('echoFlow_tone', selectedTone);
  }, [selectedTone]);

  useEffect(() => {
    localStorage.setItem('echoFlow_speed', playbackSpeed.toString());
  }, [playbackSpeed]);

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Login failed", error);
    }
  };

  const handleLogout = () => signOut(auth);

  const startTTS = async () => {
    if (!inputText) return;
    setIsSpeaking(true);
    try {
      const pcm = await generateSpeech(inputText, selectedVoice, selectedTone === 'neutral' ? undefined : selectedTone, playbackSpeed);
      await playPcm24k(pcm);
    } catch (error) {
      console.error("TTS Error", error);
    } finally {
      setIsSpeaking(false);
    }
  };

  const playItemTTS = async (text: string) => {
    try {
      const pcm = await generateSpeech(text, selectedVoice, selectedTone === 'neutral' ? undefined : selectedTone, playbackSpeed);
      await playPcm24k(pcm);
    } catch (error) {
      console.error("Item TTS Error", error);
    }
  };

  const toggleScriptDictation = () => {
    if (isDictatingScript) {
      recognitionRef.current?.stop();
      setIsDictatingScript(false);
    } else {
      if (recognitionRef.current) recognitionRef.current.stop();

      const SpeechRecognition = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
      if (!SpeechRecognition) {
        alert("Your browser does not support Speech Recognition.");
        return;
      }
      
      const recognition = new SpeechRecognition();
      recognition.lang = 'en-US';
      recognition.interimResults = true;
      recognition.continuous = true;

      recognition.onresult = (event: any) => {
        const results = Array.from(event.results);
        const dictationText = results
          .map((result: any) => result[0].transcript)
          .join('');
        setInputText(dictationText);
      };

      recognition.onend = () => {
        setIsDictatingScript(false);
      };

      recognition.start();
      recognitionRef.current = recognition;
      setIsDictatingScript(true);
    }
  };

  const handleRewrite = async (style: 'business' | 'casual') => {
    if (!inputText || isRewriting) return;
    setIsRewriting(style);
    try {
      const rewritten = await rewriteSpeechScript(inputText, style);
      setInputText(rewritten);
    } catch (error) {
      console.error("Rewrite Error", error);
    } finally {
      setIsRewriting(null);
    }
  };

  const toggleLabRecording = (index: number, targetText: string) => {
    if (labRecordingIndex === index) {
      recognitionRef.current?.stop();
      setLabRecordingIndex(null);
    } else {
      if (recognitionRef.current) recognitionRef.current.stop();
      
      const SpeechRecognition = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
      if (!SpeechRecognition) return;

      const recognition = new SpeechRecognition();
      recognition.lang = 'en-US';
      recognition.onresult = async (event: any) => {
        const result = event.results[0][0].transcript;
        setIsLabAnalyzing(index);
        try {
          const s = await getLabItemScore(targetText, result);
          setPracticeItems(prev => prev.map((item, i) => 
            i === index ? { ...item, latestScore: s } : item
          ));
        } catch (error) {
          console.error("Lab Analysis Error", error);
        } finally {
          setIsLabAnalyzing(null);
        }
      };
      
      recognition.onend = () => {
        setLabRecordingIndex(null);
      };

      recognition.start();
      recognitionRef.current = recognition;
      setLabRecordingIndex(index);
    }
  };

  const toggleRecording = () => {
    if (isRecording) {
      recognitionRef.current?.stop();
      setIsRecording(false);
    } else {
      const SpeechRecognition = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
      if (!SpeechRecognition) {
        alert("Your browser does not support Speech Recognition.");
        return;
      }
      
      const recognition = new SpeechRecognition();
      recognition.lang = 'en-US';
      recognition.interimResults = true;
      recognition.continuous = true;

      recognition.onresult = (event: any) => {
        const results = Array.from(event.results);
        const finalTranscript = results
          .map((result: any) => result[0].transcript)
          .join('');
        setTranscript(finalTranscript);
      };

      recognition.onend = () => {
        setIsRecording(false);
      };

      recognition.start();
      recognitionRef.current = recognition;
      setIsRecording(true);
      setTranscript('');
      setFeedback('');
      setScore(null);
    }
  };

  const deleteSession = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    if (!sessionId || !confirm("Are you sure you want to delete this session?")) return;
    try {
      await deleteDoc(doc(db, 'sessions', sessionId));
    } catch (error) {
      console.error("Delete Session Error", error);
    }
  };

  const downloadSession = (e: React.MouseEvent, session: PracticeSession) => {
    e.stopPropagation();
    const practiceItemsSection = session.practiceItems && session.practiceItems.length > 0
      ? `\n## Practice Items\n\n${session.practiceItems.map(item =>
          `- **${item.text}** (${item.type}): ${item.reason}${item.latestScore !== undefined ? ` — Score: ${item.latestScore}` : ''}`
        ).join('\n')}`
      : '';

    const markdown = `# ${session.title}

**Date:** ${format(new Date(session.date), 'MMMM dd, yyyy, h:mm a')}
**Score:** ${session.score}%
**Voice:** ${session.voiceSettings.voiceName} / ${session.voiceSettings.tone}

---

## Script

${session.originalText}

## Your Speech (Transcript)

${session.transcript}

## Feedback

${session.feedback}
${practiceItemsSection}
`;

    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${session.title.replace(/[^a-zA-Z0-9\u3040-\u30ff\u4e00-\u9fff]/g, '_')}_${format(new Date(session.date), 'yyyyMMdd')}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const deletePracticeItem = (index: number) => {
    if (!confirm("Remove this item from the Lab?")) return;
    setPracticeItems(prev => prev.filter((_, i) => i !== index));
  };

  const generateAnalyze = async () => {
    if (!inputText || !transcript) return;
    setIsLoadingFeedback(true);
    try {
      const result = await getSpeechFeedback(inputText, transcript);
      setFeedback(result.feedback);
      setScore(result.score);
      setPracticeItems(result.practiceItems || []);
      
      // Save to history
      if (user) {
        await addDoc(collection(db, 'sessions'), {
          userId: user.uid,
          title: title || format(new Date(), 'yyyy/MM/dd HH:mm'),
          date: new Date().toISOString(),
          originalText: inputText,
          transcript: transcript,
          feedback: result.feedback,
          score: result.score,
          practiceItems: result.practiceItems || [],
          voiceSettings: {
            voiceName: selectedVoice,
            tone: selectedTone,
            speed: playbackSpeed
          },
          createdAt: serverTimestamp()
        });
      }
    } catch (error) {
      console.error("Feedback error", error);
    } finally {
      setIsLoadingFeedback(false);
    }
  };

  const renderDiff = () => {
    if (!transcript || !inputText) return null;
    const diffs = diff.diffWords(inputText.toLowerCase(), transcript.toLowerCase());
    
    return (
      <div className="result-display font-mono text-sm leading-relaxed border-dashed">
        {diffs.map((part, index) => {
          if (part.added) {
            return <span key={index} className="diff-added"> {part.value} </span>;
          }
          if (part.removed) {
            return <span key={index} className="diff-removed"> {part.value} </span>;
          }
          return <span key={index} className="diff-correct"> {part.value} </span>;
        })}
      </div>
    );
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-[#f8fafc] flex items-center justify-center p-4">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full text-center space-y-8 bg-white p-10 rounded-[32px] shadow-2xl shadow-blue-500/10 border border-[#e2e8f0]"
        >
          <div className="flex justify-center">
            <div className="w-20 h-20 bg-blue-500/10 rounded-3xl flex items-center justify-center">
              <Sparkles className="w-10 h-10 text-blue-500" />
            </div>
          </div>
          <div className="space-y-2">
            <h1 className="text-4xl font-black text-[#1e293b] tracking-tighter">EchoFlow AI</h1>
            <p className="text-[#64748b] text-sm font-medium">Elevate Your English Speaking</p>
          </div>
          <button 
            onClick={handleLogin}
            className="w-full py-4 bg-[#3b82f6] hover:bg-[#2563eb] text-white rounded-2xl font-bold transition-all flex items-center justify-center gap-3 shadow-lg shadow-blue-500/25"
          >
            Sign in with Google
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-[#f8fafc] text-[#1e293b] flex flex-col md:flex-row font-sans overflow-hidden">
      {/* Sidebar */}
      <aside className="w-full md:w-[260px] bg-white border-r border-[#e2e8f0] flex flex-col shrink-0 h-full">
        <div className="p-8 border-b border-[#e2e8f0] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-extrabold text-xl tracking-tighter text-[#3b82f6]">EchoFlow AI</span>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto p-4 space-y-2">
          <div className="px-4 py-2 text-[10px] font-bold text-[#64748b] uppercase tracking-widest">Training</div>
          <button 
            onClick={() => setActiveTab('practice')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${activeTab === 'practice' ? 'bg-[#eff6ff] text-[#3b82f6] shadow-sm' : 'text-[#64748b] hover:bg-[#f8fafc]'}`}
          >
            <Mic className="w-5 h-5" />
            <span className="font-bold text-sm">Practice</span>
          </button>

          <button 
            onClick={() => setActiveTab('lab')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${activeTab === 'lab' ? 'bg-[#eff6ff] text-[#3b82f6] shadow-sm' : 'text-[#64748b] hover:bg-[#f8fafc]'}`}
          >
            <Sparkles className="w-5 h-5" />
            <span className="font-bold text-sm">Practice Lab</span>
          </button>
          
          <div className="px-4 py-6 text-[10px] font-bold text-[#64748b] uppercase tracking-widest">History</div>
                <div className="space-y-1 pr-10">
                  {history.map(session => (
                    <div key={session.id} className="group relative">
                      <button
                        onClick={() => {
                          setInputText(session.originalText);
                          setTranscript(session.transcript);
                          setFeedback(session.feedback);
                          setScore(session.score);
                          setPracticeItems(session.practiceItems || []);
                          setPlaybackSpeed(session.voiceSettings.speed || 1.0);
                          setTitle(session.title);
                          setActiveTab('practice');
                        }}
                        className="w-full text-left p-3 rounded-xl hover:bg-[#f8fafc] transition-all pr-16"
                      >
                        <div className="text-[10px] text-[#64748b] mb-1">{format(new Date(session.date), 'MMM dd, h:mm a')}</div>
                        <div className="text-sm font-semibold truncate group-hover:text-[#3b82f6]">{session.title}</div>
                      </button>
                      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all">
                        <button
                          onClick={(e) => downloadSession(e, session)}
                          className="p-2 text-[#cbd5e1] hover:text-[#3b82f6] transition-colors"
                          title="Download as Markdown"
                        >
                          <Download className="w-4 h-4" />
                        </button>
                        <button
                          onClick={(e) => session.id && deleteSession(e, session.id)}
                          className="p-2 text-[#cbd5e1] hover:text-[#ef4444] transition-colors"
                          title="Delete Session"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                  {history.length === 0 && (
              <p className="px-4 py-4 text-center text-xs text-[#64748b] italic opacity-50">No sessions yet</p>
            )}
          </div>
        </nav>

        <div className="p-6 border-t border-[#e2e8f0]">
          <div className="flex items-center gap-3 bg-[#f8fafc] p-3 rounded-2xl">
            {user.photoURL ? (
              <img src={user.photoURL} alt="" className="w-8 h-8 rounded-full" referrerPolicy="no-referrer" />
            ) : (
              <div className="w-8 h-8 rounded-full bg-[#e2e8f0] flex items-center justify-center">
                <UserIcon className="w-4 h-4 text-[#64748b]" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-[#1e293b] truncate">{user.displayName}</p>
            </div>
            <button onClick={handleLogout} className="text-[#64748b] hover:text-[#ef4444] transition-colors">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto p-6 md:p-10">
          {activeTab === 'practice' && (
            <div className="max-w-5xl mx-auto flex flex-col gap-8 pb-20 h-full">
              <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 shrink-0">
                <div className="space-y-1 text-left">
                  <span className="text-[11px] font-bold text-[#3b82f6] uppercase tracking-widest">Training Session</span>
                  <h2 className="text-4xl font-black text-[#1e293b] tracking-tighter">New Practice</h2>
                </div>
                <div className="flex items-center gap-4">
                  <div className="bg-white border border-[#e2e8f0] rounded-xl px-4 py-2 shadow-sm text-xs font-medium text-[#64748b]">
                    Status: <span className={transcript ? 'text-[#22c55e]' : 'text-blue-500'}>{transcript ? 'Ready to analyze' : 'Waiting for speech'}</span>
                  </div>
                </div>
              </header>

              <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-8 overflow-hidden min-h-0">
                {/* Left: Editor & Comparison */}
                <div className="flex flex-col gap-8 overflow-hidden">
                  <div className="bg-white rounded-[24px] p-8 shadow-sm border border-[#e2e8f0] flex flex-col overflow-hidden">
                    <div className="space-y-4 mb-6">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                          <label className="text-[11px] font-bold text-[#64748b] uppercase tracking-widest tracking-[0.05em]">Speech Script</label>
                          <button 
                            onClick={toggleScriptDictation}
                            className={`flex items-center gap-2 px-3 py-1 rounded-full text-[10px] font-black tracking-widest uppercase transition-all ${isDictatingScript ? 'bg-red-500 text-white animate-pulse' : 'bg-blue-50 text-blue-500 hover:bg-blue-100'}`}
                          >
                            <Mic className="w-3 h-3" />
                            {isDictatingScript ? 'Stop Dictation' : 'Dictate Script'}
                          </button>

                          <div className="flex items-center gap-2 border-l border-[#e2e8f0] pl-4">
                            <span className="text-[9px] font-bold text-[#cbd5e1] uppercase tracking-[0.2em]">Rewrite as:</span>
                            <button 
                              onClick={() => handleRewrite('business')}
                              disabled={!!isRewriting || !inputText}
                              className={`px-3 py-1 rounded-full text-[10px] font-black tracking-widest uppercase transition-all ${isRewriting === 'business' ? 'bg-[#3b82f6] text-white animate-pulse' : 'bg-[#f8fafc] text-[#64748b] hover:bg-[#eff6ff] hover:text-[#3b82f6]'}`}
                            >
                              Business
                            </button>
                            <button 
                              onClick={() => handleRewrite('casual')}
                              disabled={!!isRewriting || !inputText}
                              className={`px-3 py-1 rounded-full text-[10px] font-black tracking-widest uppercase transition-all ${isRewriting === 'casual' ? 'bg-[#3b82f6] text-white animate-pulse' : 'bg-[#f8fafc] text-[#64748b] hover:bg-[#eff6ff] hover:text-[#3b82f6]'}`}
                            >
                              Casual
                            </button>
                          </div>
                        </div>
                        <input 
                          type="text" 
                          placeholder="Untitled Session"
                          value={title}
                          onChange={(e) => setTitle(e.target.value)}
                          className="bg-transparent border-none text-right font-semibold text-sm focus:ring-0 text-[#3b82f6] placeholder-[#cbd5e1]"
                        />
                      </div>
                      <textarea 
                        placeholder="Type your English script here..."
                        value={inputText}
                        onChange={(e) => setInputText(e.target.value)}
                        className="w-full h-[240px] bg-[#fafafa] border border-[#e2e8f0] rounded-2xl px-6 py-6 focus:outline-none focus:ring-2 focus:ring-blue-500/10 focus:border-blue-500/50 transition-all text-xl leading-relaxed text-[#1e293b] resize-none border-dashed mb-4"
                      />
                    </div>

                    <div className="flex-1 overflow-y-auto space-y-4">
                      {transcript ? (
                        <div className="space-y-4">
                          <label className="text-[11px] font-bold text-[#64748b] uppercase tracking-widest tracking-[0.05em]">Comparison Results</label>
                          {renderDiff()}
                        </div>
                      ) : (
                        <div className="h-full border-2 border-dashed border-[#e2e8f0] rounded-2xl flex flex-col items-center justify-center text-[#cbd5e1] opacity-50 p-10">
                           <Mic className="w-12 h-12 mb-4" />
                           <p className="text-sm font-medium">Recorded speech will appear here</p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Recording Stage */}
                  <div className="bg-white rounded-[24px] p-8 shadow-sm border border-[#e2e8f0] flex flex-col items-center justify-center space-y-6 relative shrink-0">
                    <div className="text-center space-y-1">
                      <h3 className="text-lg font-bold text-[#1e293b]">Recite your script</h3>
                      <p className="text-[#64748b] text-xs">Listen and then record your speech</p>
                    </div>

                    <div className="flex items-center gap-6">
                      <button 
                        onClick={startTTS}
                        disabled={isSpeaking || !inputText}
                        className={`btn-tts ${isSpeaking ? 'opacity-50 cursor-not-allowed' : ''}`}
                      >
                        {isSpeaking ? 'LISTENING...' : 'LISTEN (TTS)'}
                      </button>
                      
                      <div className="relative">
                        <button 
                          onClick={toggleRecording}
                          className={`btn-mic ${isRecording ? 'bg-[#ef4444] animate-pulse' : ''}`}
                        >
                          {isRecording ? <XCircle className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
                        </button>
                        {isRecording && (
                          <div className="absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] font-black text-[#ef4444] animate-pulse">RECORDING</div>
                        )}
                      </div>

                      {transcript && !isRecording && (
                        <button 
                          onClick={generateAnalyze}
                          disabled={isLoadingFeedback}
                          className="px-6 py-3 bg-[#1e293b] text-white rounded-full font-bold text-sm hover:scale-105 active:scale-95 transition-all flex items-center gap-2 shadow-lg shadow-gray-200"
                        >
                          {isLoadingFeedback ? <RotateCcw className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4 text-blue-400" />}
                          {isLoadingFeedback ? 'ANALYZING...' : 'ANALYZE'}
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Right: Score & Feedback */}
                <div className="flex flex-col gap-6 overflow-hidden">
                  <div className="feedback-panel flex-1 flex flex-col min-h-0">
                    <div className="score-box shrink-0">
                      <div className="score-value">{score || '—'}</div>
                      <div className="score-label">Proficiency Score</div>
                    </div>
                    
                    <div className="section-label pb-4 border-b border-blue-200/50 mb-6 shrink-0">AI Feedback</div>
                    
                    <div className="flex-1 overflow-y-auto pr-2 space-y-6">
                      {feedback ? feedback.split('\n\n').map((block, i) => (
                        <div key={i} className="advice-item">
                          <div className="text-[#1e293b] prose prose-sm prose-blue leading-relaxed">
                            {block}
                          </div>
                        </div>
                      )) : (
                        <div className="h-full flex flex-col items-center justify-center text-blue-300 opacity-50 p-10 text-center space-y-4">
                           <Sparkles className="w-10 h-10" />
                           <p className="text-xs font-bold">Awaiting recording analysis</p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Voice Control Strip */}
                  <div className="bg-white border border-[#e2e8f0] rounded-[24px] p-6 shadow-sm space-y-6 shrink-0">
                    <div className="section-label">Voice Presets</div>
                    <div className="space-y-4">
                      <div className="setting-group">
                        <label>SPEAKER</label>
                        <select 
                          value={selectedVoice} 
                          onChange={(e) => setSelectedVoice(e.target.value)}
                          className="w-full"
                        >
                          {VOICES.map(v => <option key={v.name} value={v.name}>{v.label}</option>)}
                        </select>
                      </div>
                      <div className="setting-group">
                        <label>EMOTION/TONE</label>
                        <select 
                          value={selectedTone} 
                          onChange={(e) => setSelectedTone(e.target.value)}
                          className="w-full bg-[#f8fafc] border border-[#e2e8f0] rounded-xl px-4 py-2 text-xs font-bold focus:ring-2 focus:ring-blue-500/10"
                        >
                          {TONES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                        </select>
                      </div>

                      <div className="setting-group">
                        <label className="flex justify-between items-center w-full">
                          <span>SPEED</span>
                          <span className="text-blue-500 font-black">{playbackSpeed}x</span>
                        </label>
                        <input 
                          type="range" 
                          min="0.5" 
                          max="2.0" 
                          step="0.1" 
                          value={playbackSpeed} 
                          onChange={(e) => setPlaybackSpeed(parseFloat(e.target.value))}
                          className="w-full h-1.5 bg-blue-100 rounded-lg appearance-none cursor-pointer accent-blue-500"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'lab' && (
            <div className="max-w-4xl mx-auto flex flex-col gap-8 pb-20">
              <header className="space-y-1">
                <span className="text-[11px] font-bold text-[#3b82f6] uppercase tracking-widest">Mastery Lab</span>
                <h2 className="text-4xl font-black text-[#1e293b] tracking-tighter">Repetitive Practice</h2>
                <p className="text-[#64748b] text-sm font-medium">Focus on areas needing clinical attention from your analysis results.</p>
              </header>

              {practiceItems.length > 0 ? (
                <div className="grid grid-cols-1 gap-4">
                  {practiceItems.map((item, i) => (
                    <motion.div 
                      key={i}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.05 }}
                      className="bg-white border border-[#e2e8f0] rounded-[24px] p-8 shadow-sm hover:shadow-md transition-all flex flex-col md:flex-row items-start md:items-center justify-between gap-6"
                    >
                      <div className="space-y-2 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-black tracking-widest uppercase ${item.type === 'word' ? 'bg-purple-100 text-purple-600' : 'bg-orange-100 text-orange-600'}`}>
                            {item.type}
                          </span>
                        </div>
                        <h3 className="text-2xl font-bold text-[#1e293b]">{item.text}</h3>
                        <p className="text-[#64748b] text-sm/relaxed font-medium">{item.reason}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        {item.latestScore !== undefined && (
                          <div className="flex flex-col items-end mr-2">
                             <div className="text-[10px] font-black text-[#64748b] uppercase tracking-widest">Score</div>
                             <div className="text-xl font-black text-[#3b82f6]">{item.latestScore}</div>
                          </div>
                        )}

                        <button 
                          onClick={() => deletePracticeItem(i)}
                          className="w-10 h-10 text-[#cbd5e1] hover:text-[#ef4444] transition-colors"
                          title="Remove from Lab"
                        >
                          <Trash2 className="w-5 h-5" />
                        </button>

                        <button 
                          onClick={() => playItemTTS(item.text)}
                          className="w-12 h-12 bg-blue-50 hover:bg-blue-100 rounded-2xl flex items-center justify-center text-blue-500 transition-all"
                          title="Listen"
                        >
                          <Volume2 className="w-5 h-5" />
                        </button>

                        <button 
                          onClick={() => toggleLabRecording(i, item.text)}
                          disabled={isLabAnalyzing === i}
                          className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg transition-all ${
                            labRecordingIndex === i 
                            ? 'bg-red-500 text-white animate-pulse shadow-red-500/20' 
                            : 'bg-white border border-[#e2e8f0] text-[#1e293b] hover:border-blue-500/50 shadow-blue-500/5'
                          }`}
                        >
                          {isLabAnalyzing === i ? (
                            <RotateCcw className="w-5 h-5 animate-spin" />
                          ) : (
                            <Mic className={`w-6 h-6 ${labRecordingIndex === i ? 'text-white' : 'text-[#3b82f6]'}`} />
                          )}
                        </button>
                      </div>
                    </motion.div>
                  ))}
                </div>
              ) : (
                <div className="bg-white border-2 border-dashed border-[#e2e8f0] rounded-[32px] p-20 text-center space-y-4">
                  <HelpCircle className="w-16 h-16 text-[#cbd5e1] mx-auto opacity-50" />
                  <div className="space-y-1">
                    <h3 className="text-lg font-bold text-[#1e293b]">Lab is currently empty</h3>
                    <p className="text-[#64748b] text-sm max-w-xs mx-auto">Complete a practice session and analyze it to populate the Lab with clinical items.</p>
                  </div>
                  <button 
                    onClick={() => setActiveTab('practice')}
                    className="px-6 py-2.5 bg-blue-500 text-white rounded-full font-bold text-sm shadow-lg shadow-blue-500/10"
                  >
                    Go back to Practice
                  </button>
                </div>
              )}
            </div>
          )}

          {activeTab === 'history' && (
            <div className="max-w-4xl mx-auto space-y-10">
               <header className="space-y-1">
                  <span className="text-[11px] font-bold text-[#3b82f6] uppercase tracking-widest">Achievements</span>
                  <h2 className="text-4xl font-black text-[#1e293b] tracking-tighter">Your Progress</h2>
                </header>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {history.map(session => (
                    <motion.div 
                      key={session.id}
                      className="bg-white border border-[#e2e8f0] rounded-[24px] p-6 shadow-sm hover:border-[#3b82f6]/50 transition-all cursor-pointer"
                      onClick={() => {
                        setInputText(session.originalText);
                        setTranscript(session.transcript);
                        setFeedback(session.feedback);
                        setScore(session.score);
                        setPracticeItems(session.practiceItems || []);
                        setPlaybackSpeed(session.voiceSettings.speed || 1.0);
                        setTitle(session.title);
                        setActiveTab('practice');
                      }}
                    >
                      <div className="flex justify-between items-start mb-4">
                        <div className="space-y-1">
                          <p className="text-[10px] font-bold text-[#64748b]">{format(new Date(session.date), 'MMMM dd, yyyy')}</p>
                          <h3 className="font-bold text-[#1e293b]">{session.title}</h3>
                        </div>
                        <div className="w-12 h-12 rounded-full bg-blue-50 flex items-center justify-center text-sm font-black text-[#3b82f6]">
                          {session.score}%
                        </div>
                      </div>
                      <p className="text-xs text-[#64748b] line-clamp-2 leading-relaxed italic mb-4">"{session.originalText}"</p>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1 text-[10px] font-bold text-[#3b82f6] uppercase">
                          Review Session <ChevronRight className="w-3 h-3" />
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={(e) => downloadSession(e, session)}
                            className="p-2 text-[#cbd5e1] hover:text-[#3b82f6] transition-colors rounded-lg hover:bg-blue-50"
                            title="Download as Markdown"
                          >
                            <Download className="w-4 h-4" />
                          </button>
                          <button
                            onClick={(e) => session.id && deleteSession(e, session.id)}
                            className="p-2 text-[#cbd5e1] hover:text-[#ef4444] transition-colors rounded-lg hover:bg-red-50"
                            title="Delete Session"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
