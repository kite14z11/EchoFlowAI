import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Mic,
  RotateCcw,
  History,
  LogOut,
  User as UserIcon,
  ChevronRight,
  ChevronLeft,
  Sparkles,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Volume2,
  Trash2,
  Download,
  CalendarDays
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
  const [activeTab, setActiveTab] = useState<'practice' | 'lab' | 'history' | 'calendar'>('practice');
  const [calendarDate, setCalendarDate] = useState(new Date());
  const [isLoadingFeedback, setIsLoadingFeedback] = useState(false);
  const [isDictatingScript, setIsDictatingScript] = useState(false);
  const [isRewriting, setIsRewriting] = useState<'business' | 'casual' | null>(null);

  // Speech Recognition
  const recognitionRef = useRef<any>(null);
  const recordingActiveRef  = useRef(false);
  const recordingAccumRef   = useRef('');
  const dictatingActiveRef  = useRef(false);
  const dictationAccumRef   = useRef('');

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
      dictatingActiveRef.current = false;
      recognitionRef.current?.stop();
      setIsDictatingScript(false);
    } else {
      if (recognitionRef.current) recognitionRef.current.stop();

      const SpeechRecognition = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
      if (!SpeechRecognition) {
        alert("Your browser does not support Speech Recognition.");
        return;
      }

      dictationAccumRef.current = '';
      dictatingActiveRef.current = true;

      const startDictation = (): any => {
        const recognition = new SpeechRecognition();
        recognition.lang = 'en-US';
        recognition.interimResults = true;
        recognition.continuous = false;

        let sessionFinal = '';

        // Android Chrome re-sends the ENTIRE utterance from session start in
        // each new recognition instance (cumulative transcript). So "I'm pretty"
        // in session 2 already includes "I'm" from session 1.
        // Strategy: if the new text starts with what we already have, replace
        // the accumulator rather than appending to it.
        const mergeIntoAccum = (newText: string) => {
          if (!newText) return;
          const base = dictationAccumRef.current.trimEnd();
          const incoming = newText.trim();
          if (!base || incoming.toLowerCase().startsWith(base.toLowerCase())) {
            dictationAccumRef.current = incoming + ' ';
          } else {
            dictationAccumRef.current = base + ' ' + incoming + ' ';
          }
        };

        const displayText = (sfAndInterim: string): string => {
          const base = dictationAccumRef.current.trimEnd();
          const incoming = sfAndInterim.trim();
          if (base && incoming.toLowerCase().startsWith(base.toLowerCase())) {
            return sfAndInterim;
          }
          return dictationAccumRef.current + sfAndInterim;
        };

        recognition.onresult = (event: any) => {
          sessionFinal = '';
          let interim = '';
          for (let i = event.resultIndex; i < event.results.length; i++) {
            if (event.results[i].isFinal) {
              sessionFinal += event.results[i][0].transcript;
            } else {
              interim = event.results[i][0].transcript;
            }
          }
          setInputText(displayText(sessionFinal + interim));
        };

        recognition.onerror = (event: any) => {
          if (event.error !== 'no-speech' && event.error !== 'aborted') {
            dictatingActiveRef.current = false;
            setIsDictatingScript(false);
          }
        };

        recognition.onend = () => {
          mergeIntoAccum(sessionFinal);
          if (dictatingActiveRef.current) {
            recognitionRef.current = startDictation();
          } else {
            setIsDictatingScript(false);
          }
        };

        recognition.start();
        return recognition;
      };

      recognitionRef.current = startDictation();
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
      recordingActiveRef.current = false;
      recognitionRef.current?.stop();
      setIsRecording(false);
    } else {
      const SpeechRecognition = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
      if (!SpeechRecognition) {
        alert("Your browser does not support Speech Recognition.");
        return;
      }

      recordingAccumRef.current = '';
      recordingActiveRef.current = true;

      const startRecording = (): any => {
        const recognition = new SpeechRecognition();
        recognition.lang = 'en-US';
        recognition.interimResults = true;
        recognition.continuous = false;

        let sessionFinal = '';

        // Android Chrome re-sends the ENTIRE utterance from session start in
        // each new recognition instance (cumulative transcript). So "I'm pretty"
        // in session 2 already includes "I'm" from session 1.
        // Strategy: if the new text starts with what we already have, replace
        // the accumulator rather than appending to it.
        const mergeIntoAccum = (newText: string) => {
          if (!newText) return;
          const base = recordingAccumRef.current.trimEnd();
          const incoming = newText.trim();
          if (!base || incoming.toLowerCase().startsWith(base.toLowerCase())) {
            recordingAccumRef.current = incoming + ' ';
          } else {
            recordingAccumRef.current = base + ' ' + incoming + ' ';
          }
        };

        const displayText = (sfAndInterim: string): string => {
          const base = recordingAccumRef.current.trimEnd();
          const incoming = sfAndInterim.trim();
          if (base && incoming.toLowerCase().startsWith(base.toLowerCase())) {
            return sfAndInterim;
          }
          return recordingAccumRef.current + sfAndInterim;
        };

        recognition.onresult = (event: any) => {
          sessionFinal = '';
          let interim = '';
          for (let i = event.resultIndex; i < event.results.length; i++) {
            if (event.results[i].isFinal) {
              sessionFinal += event.results[i][0].transcript;
            } else {
              interim = event.results[i][0].transcript;
            }
          }
          setTranscript(displayText(sessionFinal + interim));
        };

        recognition.onerror = (event: any) => {
          if (event.error !== 'no-speech' && event.error !== 'aborted') {
            recordingActiveRef.current = false;
            setIsRecording(false);
          }
        };

        recognition.onend = () => {
          mergeIntoAccum(sessionFinal);
          if (recordingActiveRef.current) {
            recognitionRef.current = startRecording();
          } else {
            setIsRecording(false);
          }
        };

        recognition.start();
        return recognition;
      };

      recognitionRef.current = startRecording();
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

  const sessionsByDay = useMemo(() => {
    const map: Record<string, number> = {};
    history.forEach(session => {
      const day = format(new Date(session.date), 'yyyy-MM-dd');
      map[day] = (map[day] || 0) + 1;
    });
    return map;
  }, [history]);

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
    <div className="h-screen bg-[#f8fafc] text-[#1e293b] flex flex-col font-sans overflow-hidden">

      {/* ── Top Header ── */}
      <header className="bg-white border-b border-[#e2e8f0] shrink-0 z-10">
        {/* Logo + User */}
        <div className="flex items-center justify-between px-4 sm:px-6 h-14">
          <span className="font-extrabold text-lg tracking-tighter text-[#3b82f6]">EchoFlow AI</span>
          <div className="flex items-center gap-2">
            {user.photoURL ? (
              <img src={user.photoURL} alt="" className="w-7 h-7 rounded-full" referrerPolicy="no-referrer" />
            ) : (
              <div className="w-7 h-7 rounded-full bg-[#e2e8f0] flex items-center justify-center">
                <UserIcon className="w-4 h-4 text-[#64748b]" />
              </div>
            )}
            <span className="hidden sm:block text-xs font-bold text-[#1e293b] max-w-[120px] truncate">{user.displayName}</span>
            <button onClick={handleLogout} className="p-1.5 text-[#64748b] hover:text-[#ef4444] transition-colors" title="Sign out">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Tab Bar */}
        <div className="flex border-t border-[#e2e8f0] px-2 sm:px-4 overflow-x-auto">
          {([
            { id: 'practice',  label: 'Practice',  icon: Mic         },
            { id: 'lab',       label: 'Lab',        icon: Sparkles    },
            { id: 'history',   label: 'History',    icon: History     },
            { id: 'calendar',  label: 'Calendar',   icon: CalendarDays},
          ] as const).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-bold border-b-2 transition-all whitespace-nowrap ${
                activeTab === id
                  ? 'border-[#3b82f6] text-[#3b82f6]'
                  : 'border-transparent text-[#64748b] hover:text-[#1e293b]'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
      </header>

      {/* ── Main Content ── */}
      <main className="flex-1 overflow-y-auto">
        <div className="p-4 sm:p-8">

          {/* ── Practice Tab ── */}
          {activeTab === 'practice' && (
            <div className="max-w-5xl mx-auto flex flex-col gap-6 pb-10">
              <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
                <div className="space-y-1">
                  <span className="text-[11px] font-bold text-[#3b82f6] uppercase tracking-widest">Training Session</span>
                  <h2 className="text-3xl sm:text-4xl font-black text-[#1e293b] tracking-tighter">New Practice</h2>
                </div>
                <div className="bg-white border border-[#e2e8f0] rounded-xl px-4 py-2 shadow-sm text-xs font-medium text-[#64748b] self-start sm:self-auto">
                  Status: <span className={transcript ? 'text-[#22c55e]' : 'text-blue-500'}>{transcript ? 'Ready to analyze' : 'Waiting for speech'}</span>
                </div>
              </header>

              <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
                {/* Left */}
                <div className="flex flex-col gap-6">
                  <div className="bg-white rounded-[24px] p-5 sm:p-8 shadow-sm border border-[#e2e8f0]">
                    <div className="space-y-4 mb-5">
                      <div className="flex flex-wrap items-center gap-2 justify-between">
                        <div className="flex flex-wrap items-center gap-2">
                          <label className="text-[11px] font-bold text-[#64748b] uppercase tracking-widest">Script</label>
                          <button
                            onClick={toggleScriptDictation}
                            className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-black tracking-widest uppercase transition-all ${isDictatingScript ? 'bg-red-500 text-white animate-pulse' : 'bg-blue-50 text-blue-500 hover:bg-blue-100'}`}
                          >
                            <Mic className="w-3 h-3" />
                            {isDictatingScript ? 'Stop' : 'Dictate'}
                          </button>
                          <div className="flex items-center gap-1.5 border-l border-[#e2e8f0] pl-2">
                            <span className="text-[9px] font-bold text-[#cbd5e1] uppercase tracking-[0.2em]">Rewrite:</span>
                            <button
                              onClick={() => handleRewrite('business')}
                              disabled={!!isRewriting || !inputText}
                              className={`px-3 py-1 rounded-full text-[10px] font-black tracking-widest uppercase transition-all ${isRewriting === 'business' ? 'bg-[#3b82f6] text-white animate-pulse' : 'bg-[#f8fafc] text-[#64748b] hover:bg-[#eff6ff] hover:text-[#3b82f6]'}`}
                            >Business</button>
                            <button
                              onClick={() => handleRewrite('casual')}
                              disabled={!!isRewriting || !inputText}
                              className={`px-3 py-1 rounded-full text-[10px] font-black tracking-widest uppercase transition-all ${isRewriting === 'casual' ? 'bg-[#3b82f6] text-white animate-pulse' : 'bg-[#f8fafc] text-[#64748b] hover:bg-[#eff6ff] hover:text-[#3b82f6]'}`}
                            >Casual</button>
                          </div>
                        </div>
                        <input
                          type="text"
                          placeholder="Untitled Session"
                          value={title}
                          onChange={(e) => setTitle(e.target.value)}
                          className="bg-transparent border-none text-right font-semibold text-sm focus:ring-0 text-[#3b82f6] placeholder-[#cbd5e1] min-w-0 w-32 sm:w-auto"
                        />
                      </div>
                      <textarea
                        placeholder="Type your English script here..."
                        value={inputText}
                        onChange={(e) => setInputText(e.target.value)}
                        className="w-full h-44 sm:h-56 bg-[#fafafa] border border-dashed border-[#e2e8f0] rounded-2xl px-5 py-5 focus:outline-none focus:ring-2 focus:ring-blue-500/10 focus:border-blue-500/50 transition-all text-lg leading-relaxed text-[#1e293b] resize-none"
                      />
                    </div>

                    {transcript ? (
                      <div className="space-y-3">
                        <label className="text-[11px] font-bold text-[#64748b] uppercase tracking-widest">Comparison Results</label>
                        {renderDiff()}
                      </div>
                    ) : (
                      <div className="h-20 border-2 border-dashed border-[#e2e8f0] rounded-2xl flex flex-col items-center justify-center text-[#cbd5e1] opacity-50">
                        <Mic className="w-7 h-7 mb-1" />
                        <p className="text-xs font-medium">Recorded speech will appear here</p>
                      </div>
                    )}
                  </div>

                  {/* Recording controls */}
                  <div className="bg-white rounded-[24px] p-6 sm:p-8 shadow-sm border border-[#e2e8f0] flex flex-col items-center space-y-5">
                    <div className="text-center space-y-1">
                      <h3 className="text-lg font-bold text-[#1e293b]">Recite your script</h3>
                      <p className="text-[#64748b] text-xs">Listen and then record your speech</p>
                    </div>
                    <div className="flex items-center gap-4 sm:gap-6 flex-wrap justify-center">
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
                          <div className="absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] font-black text-[#ef4444] animate-pulse">RECORDING</div>
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

                {/* Right: Score & Voice */}
                <div className="flex flex-col gap-6">
                  <div className="feedback-panel flex flex-col">
                    <div className="score-box shrink-0">
                      <div className="score-value">{score || '—'}</div>
                      <div className="score-label">Proficiency Score</div>
                    </div>
                    <div className="section-label pb-4 border-b border-blue-200/50 mb-6 shrink-0">AI Feedback</div>
                    <div className="space-y-6">
                      {feedback ? feedback.split('\n\n').map((block, i) => (
                        <div key={i} className="advice-item">
                          <div className="text-[#1e293b] prose prose-sm prose-blue leading-relaxed">{block}</div>
                        </div>
                      )) : (
                        <div className="flex flex-col items-center justify-center text-blue-300 opacity-50 py-10 text-center space-y-3">
                          <Sparkles className="w-10 h-10" />
                          <p className="text-xs font-bold">Awaiting recording analysis</p>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="bg-white border border-[#e2e8f0] rounded-[24px] p-6 shadow-sm space-y-6">
                    <div className="section-label">Voice Presets</div>
                    <div className="space-y-4">
                      <div className="setting-group">
                        <label>SPEAKER</label>
                        <select value={selectedVoice} onChange={(e) => setSelectedVoice(e.target.value)} className="w-full">
                          {VOICES.map(v => <option key={v.name} value={v.name}>{v.label}</option>)}
                        </select>
                      </div>
                      <div className="setting-group">
                        <label>EMOTION/TONE</label>
                        <select value={selectedTone} onChange={(e) => setSelectedTone(e.target.value)} className="w-full bg-[#f8fafc] border border-[#e2e8f0] rounded-xl px-4 py-2 text-xs font-bold focus:ring-2 focus:ring-blue-500/10">
                          {TONES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                        </select>
                      </div>
                      <div className="setting-group">
                        <label className="flex justify-between items-center w-full">
                          <span>SPEED</span>
                          <span className="text-blue-500 font-black">{playbackSpeed}x</span>
                        </label>
                        <input type="range" min="0.5" max="2.0" step="0.1" value={playbackSpeed}
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

          {/* ── Lab Tab ── */}
          {activeTab === 'lab' && (
            <div className="max-w-4xl mx-auto flex flex-col gap-8 pb-10">
              <header className="space-y-1">
                <span className="text-[11px] font-bold text-[#3b82f6] uppercase tracking-widest">Mastery Lab</span>
                <h2 className="text-3xl sm:text-4xl font-black text-[#1e293b] tracking-tighter">Repetitive Practice</h2>
                <p className="text-[#64748b] text-sm font-medium">Focus on areas needing attention from your analysis results.</p>
              </header>

              {practiceItems.length > 0 ? (
                <div className="grid grid-cols-1 gap-4">
                  {practiceItems.map((item, i) => (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.05 }}
                      className="bg-white border border-[#e2e8f0] rounded-[24px] p-5 sm:p-8 shadow-sm hover:shadow-md transition-all flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4"
                    >
                      <div className="space-y-2 flex-1">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-black tracking-widest uppercase ${item.type === 'word' ? 'bg-purple-100 text-purple-600' : 'bg-orange-100 text-orange-600'}`}>
                          {item.type}
                        </span>
                        <h3 className="text-2xl font-bold text-[#1e293b]">{item.text}</h3>
                        <p className="text-[#64748b] text-sm leading-relaxed font-medium">{item.reason}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        {item.latestScore !== undefined && (
                          <div className="flex flex-col items-end mr-2">
                            <div className="text-[10px] font-black text-[#64748b] uppercase tracking-widest">Score</div>
                            <div className="text-xl font-black text-[#3b82f6]">{item.latestScore}</div>
                          </div>
                        )}
                        <button onClick={() => deletePracticeItem(i)} className="w-10 h-10 text-[#cbd5e1] hover:text-[#ef4444] transition-colors" title="Remove from Lab">
                          <Trash2 className="w-5 h-5" />
                        </button>
                        <button onClick={() => playItemTTS(item.text)} className="w-12 h-12 bg-blue-50 hover:bg-blue-100 rounded-2xl flex items-center justify-center text-blue-500 transition-all" title="Listen">
                          <Volume2 className="w-5 h-5" />
                        </button>
                        <button
                          onClick={() => toggleLabRecording(i, item.text)}
                          disabled={isLabAnalyzing === i}
                          className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg transition-all ${labRecordingIndex === i ? 'bg-red-500 text-white animate-pulse shadow-red-500/20' : 'bg-white border border-[#e2e8f0] text-[#1e293b] hover:border-blue-500/50 shadow-blue-500/5'}`}
                        >
                          {isLabAnalyzing === i
                            ? <RotateCcw className="w-5 h-5 animate-spin" />
                            : <Mic className={`w-6 h-6 ${labRecordingIndex === i ? 'text-white' : 'text-[#3b82f6]'}`} />}
                        </button>
                      </div>
                    </motion.div>
                  ))}
                </div>
              ) : (
                <div className="bg-white border-2 border-dashed border-[#e2e8f0] rounded-[32px] p-16 sm:p-20 text-center space-y-4">
                  <HelpCircle className="w-16 h-16 text-[#cbd5e1] mx-auto opacity-50" />
                  <div className="space-y-1">
                    <h3 className="text-lg font-bold text-[#1e293b]">Lab is currently empty</h3>
                    <p className="text-[#64748b] text-sm max-w-xs mx-auto">Complete a practice session and analyze it to populate the Lab.</p>
                  </div>
                  <button onClick={() => setActiveTab('practice')} className="px-6 py-2.5 bg-blue-500 text-white rounded-full font-bold text-sm shadow-lg shadow-blue-500/10">
                    Go to Practice
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── History Tab ── */}
          {activeTab === 'history' && (
            <div className="max-w-4xl mx-auto space-y-8 pb-10">
              <header className="space-y-1">
                <span className="text-[11px] font-bold text-[#3b82f6] uppercase tracking-widest">Achievements</span>
                <h2 className="text-3xl sm:text-4xl font-black text-[#1e293b] tracking-tighter">Your Progress</h2>
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
                        <button onClick={(e) => downloadSession(e, session)} className="p-2 text-[#cbd5e1] hover:text-[#3b82f6] transition-colors rounded-lg hover:bg-blue-50" title="Download as Markdown">
                          <Download className="w-4 h-4" />
                        </button>
                        <button onClick={(e) => session.id && deleteSession(e, session.id)} className="p-2 text-[#cbd5e1] hover:text-[#ef4444] transition-colors rounded-lg hover:bg-red-50" title="Delete Session">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </motion.div>
                ))}
                {history.length === 0 && (
                  <div className="col-span-2 bg-white border-2 border-dashed border-[#e2e8f0] rounded-[32px] p-16 text-center space-y-3">
                    <History className="w-14 h-14 text-[#cbd5e1] mx-auto opacity-50" />
                    <p className="text-[#64748b] text-sm">No sessions yet. Start practicing!</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Calendar Tab ── */}
          {activeTab === 'calendar' && (() => {
            const year  = calendarDate.getFullYear();
            const month = calendarDate.getMonth();
            const firstDay   = new Date(year, month, 1).getDay();
            const daysInMonth = new Date(year, month + 1, 0).getDate();
            const todayStr   = format(new Date(), 'yyyy-MM-dd');
            const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;
            const monthTotal  = Object.entries(sessionsByDay)
              .filter(([d]) => d.startsWith(monthPrefix))
              .reduce((sum, [, c]) => sum + c, 0);
            const activeDays = Object.keys(sessionsByDay)
              .filter(d => d.startsWith(monthPrefix)).length;

            return (
              <div className="max-w-lg mx-auto space-y-6 pb-10">
                <header className="space-y-1">
                  <span className="text-[11px] font-bold text-[#3b82f6] uppercase tracking-widest">Activity</span>
                  <h2 className="text-3xl sm:text-4xl font-black text-[#1e293b] tracking-tighter">Practice Calendar</h2>
                </header>

                <div className="bg-white rounded-[24px] p-5 sm:p-6 shadow-sm border border-[#e2e8f0]">
                  {/* Month navigation */}
                  <div className="flex items-center justify-between mb-5">
                    <button
                      onClick={() => setCalendarDate(new Date(year, month - 1, 1))}
                      className="p-2 rounded-xl hover:bg-[#f8fafc] text-[#64748b] transition-colors"
                    >
                      <ChevronLeft className="w-5 h-5" />
                    </button>
                    <h3 className="font-black text-base sm:text-lg text-[#1e293b]">{format(calendarDate, 'MMMM yyyy')}</h3>
                    <button
                      onClick={() => setCalendarDate(new Date(year, month + 1, 1))}
                      className="p-2 rounded-xl hover:bg-[#f8fafc] text-[#64748b] transition-colors"
                    >
                      <ChevronRight className="w-5 h-5" />
                    </button>
                  </div>

                  {/* Day headers */}
                  <div className="grid grid-cols-7 mb-1">
                    {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => (
                      <div key={d} className="text-center text-[10px] font-bold text-[#94a3b8] uppercase py-1.5">{d}</div>
                    ))}
                  </div>

                  {/* Grid */}
                  <div className="grid grid-cols-7 gap-1">
                    {Array.from({ length: firstDay }).map((_, i) => <div key={`e${i}`} />)}
                    {Array.from({ length: daysInMonth }).map((_, i) => {
                      const day = i + 1;
                      const dateStr = `${monthPrefix}-${String(day).padStart(2, '0')}`;
                      const count   = sessionsByDay[dateStr] || 0;
                      const isToday = dateStr === todayStr;
                      return (
                        <div
                          key={day}
                          className={`aspect-square flex flex-col items-center justify-center rounded-xl transition-colors ${isToday ? 'bg-blue-50 ring-1 ring-blue-200' : 'hover:bg-[#f8fafc]'}`}
                        >
                          <span className={`text-xs sm:text-sm font-semibold leading-none ${isToday ? 'text-[#3b82f6]' : 'text-[#1e293b]'}`}>{day}</span>
                          {count > 0 && (
                            <div className={`w-1.5 h-1.5 rounded-full mt-1 ${count >= 2 ? 'bg-green-500' : 'bg-[#3b82f6]'}`} />
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Legend */}
                  <div className="flex items-center gap-5 mt-5 pt-4 border-t border-[#e2e8f0]">
                    <div className="flex items-center gap-2">
                      <div className="w-2.5 h-2.5 rounded-full bg-[#3b82f6]" />
                      <span className="text-xs text-[#64748b]">1 session</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
                      <span className="text-xs text-[#64748b]">2+ sessions</span>
                    </div>
                  </div>
                </div>

                {/* Monthly stats */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-white rounded-[20px] p-5 shadow-sm border border-[#e2e8f0] text-center">
                    <div className="text-3xl font-black text-[#3b82f6]">{monthTotal}</div>
                    <div className="text-[11px] font-bold text-[#64748b] uppercase tracking-widest mt-1">Sessions This Month</div>
                  </div>
                  <div className="bg-white rounded-[20px] p-5 shadow-sm border border-[#e2e8f0] text-center">
                    <div className="text-3xl font-black text-green-500">{activeDays}</div>
                    <div className="text-[11px] font-bold text-[#64748b] uppercase tracking-widest mt-1">Active Days</div>
                  </div>
                </div>
              </div>
            );
          })()}

        </div>
      </main>
    </div>
  );
}
