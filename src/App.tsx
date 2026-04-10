import React, { useState, useEffect, useRef } from 'react';
import { auth, db, loginWithGoogle, logout } from './lib/firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import { collection, query, where, onSnapshot, addDoc, serverTimestamp, orderBy } from 'firebase/firestore';
import { getWordDetails, getPronunciationFeedback, getRoleplayResponse, generateWordImage, transcribeAudio, WordDetails } from './lib/gemini';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Toaster } from '@/components/ui/sonner';
import { toast } from 'sonner';
import { Search, BookOpen, Mic, MessageSquare, LogOut, LogIn, Save, Play, CheckCircle2, AlertCircle, Volume2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [vocabulary, setVocabulary] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResult, setSearchResult] = useState<WordDetails | null>(null);
  const [searching, setSearching] = useState(false);
  const [wordImage, setWordImage] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isRoleplayRecording, setIsRoleplayRecording] = useState(false);
  const [feedback, setFeedback] = useState<{ score: number; feedback: string } | null>(null);
  const [roleplayMessages, setRoleplayMessages] = useState<{ role: 'user' | 'model'; text: string }[]>([]);
  const [userMessage, setUserMessage] = useState('');
  const [isConfigValid, setIsConfigValid] = useState(true);

  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const audioChunks = useRef<Blob[]>([]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
      
      // Check if config is still placeholders
      import('../firebase-applet-config.json').then(config => {
        if (config.apiKey === 'PLACEHOLDER_API_KEY' || config.apiKey === '') {
          setIsConfigValid(false);
        } else {
          setIsConfigValid(true);
        }
      });
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (user && isConfigValid) {
      const q = query(
        collection(db, 'vocabulary'),
        where('userId', '==', user.uid),
        orderBy('createdAt', 'desc')
      );
      const unsubscribe = onSnapshot(q, (snapshot) => {
        setVocabulary(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
      }, (err) => {
        console.error("Firestore error:", err);
      });
      return unsubscribe;
    }
  }, [user, isConfigValid]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setSearching(true);
    setWordImage(null);
    setFeedback(null);
    try {
      const details = await getWordDetails(searchQuery);
      setSearchResult(details);
      
      // Generate image in parallel or after text
      generateWordImage(details.imagePrompt).then(img => {
        if (img) setWordImage(img);
      });

      if (user && isConfigValid) {
        await addDoc(collection(db, 'vocabulary'), {
          ...details,
          userId: user.uid,
          createdAt: serverTimestamp(),
          masteryLevel: 0
        });
        toast.success(`Saved "${details.word}" to your vocabulary!`);
      }
    } catch (error) {
      console.error(error);
      toast.error("Failed to fetch word details.");
    } finally {
      setSearching(false);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder.current = new MediaRecorder(stream);
      audioChunks.current = [];
      
      mediaRecorder.current.ondataavailable = (e) => {
        audioChunks.current.push(e.data);
      };

      mediaRecorder.current.onstop = async () => {
        const audioBlob = new Blob(audioChunks.current, { type: 'audio/wav' });
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = async () => {
          const base64Audio = (reader.result as string).split(',')[1];
          if (searchResult) {
            toast.info("Analyzing pronunciation...");
            try {
              const res = await getPronunciationFeedback(base64Audio, searchResult.word);
              setFeedback(res);
            } catch (err) {
              toast.error("Failed to analyze audio.");
            }
          }
        };
      };

      mediaRecorder.current.start();
      setIsRecording(true);
    } catch (err) {
      toast.error("Microphone access denied.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorder.current && isRecording) {
      mediaRecorder.current.stop();
      setIsRecording(false);
    }
  };

  const handleRoleplaySend = async (textOverride?: string) => {
    const messageToSend = textOverride || userMessage;
    if (!messageToSend.trim()) return;
    const newMessages = [...roleplayMessages, { role: 'user' as const, text: messageToSend }];
    setRoleplayMessages(newMessages);
    setUserMessage('');
    
    try {
      const history = newMessages.map(m => ({
        role: m.role,
        parts: [{ text: m.text }]
      }));
      const aiResponse = await getRoleplayResponse(history, messageToSend, "Ordering coffee at a busy cafe");
      setRoleplayMessages([...newMessages, { role: 'model' as const, text: aiResponse }]);
    } catch (err) {
      toast.error("Failed to get AI response.");
    }
  };

  const startRoleplayRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder.current = new MediaRecorder(stream);
      audioChunks.current = [];
      
      mediaRecorder.current.ondataavailable = (e) => {
        audioChunks.current.push(e.data);
      };

      mediaRecorder.current.onstop = async () => {
        const audioBlob = new Blob(audioChunks.current, { type: 'audio/wav' });
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = async () => {
          const base64Audio = (reader.result as string).split(',')[1];
          toast.info("Transcribing your voice...");
          try {
            const text = await transcribeAudio(base64Audio);
            if (text.trim()) {
              handleRoleplaySend(text);
            } else {
              toast.error("Could not understand the audio.");
            }
          } catch (err) {
            toast.error("Failed to transcribe audio.");
          }
        };
      };

      mediaRecorder.current.start();
      setIsRoleplayRecording(true);
    } catch (err) {
      toast.error("Microphone access denied.");
    }
  };

  const stopRoleplayRecording = () => {
    if (mediaRecorder.current && isRoleplayRecording) {
      mediaRecorder.current.stop();
      setIsRoleplayRecording(false);
    }
  };

  const speak = (text: string) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    window.speechSynthesis.speak(utterance);
  };

  if (loading) return <div className="flex items-center justify-center h-screen">Loading...</div>;

  return (
    <div className="min-h-screen bg-[#f5f5f5] text-[#1a1a1a] font-sans">
      <Toaster position="top-center" />
      
      {!isConfigValid && (
        <div className="bg-amber-50 border-b border-amber-200 p-2 text-center text-amber-800 text-sm flex items-center justify-center gap-2">
          <AlertCircle className="w-4 h-4" />
          Firebase is not fully configured. Vocabulary saving will be disabled.
        </div>
      )}

      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-blue-600 p-1.5 rounded-lg">
              <BookOpen className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">LinguistAI</h1>
          </div>
          
          <div className="flex items-center gap-4">
            {user ? (
              <div className="flex items-center gap-3">
                <Avatar className="w-8 h-8 border border-gray-200">
                  <AvatarImage src={user.photoURL || ''} />
                  <AvatarFallback>{user.displayName?.charAt(0) || 'U'}</AvatarFallback>
                </Avatar>
                <Button variant="ghost" size="sm" onClick={logout} className="text-gray-500 hover:text-red-600">
                  <LogOut className="w-4 h-4 mr-2" />
                  Sign Out
                </Button>
              </div>
            ) : (
              <Button size="sm" onClick={loginWithGoogle} className="bg-blue-600 hover:bg-blue-700">
                <LogIn className="w-4 h-4 mr-2" />
                Sign In
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8">
        <Tabs defaultValue="search" className="space-y-8">
          <div className="flex justify-center">
            <TabsList className="bg-white border border-gray-200 p-1 rounded-full h-12">
              <TabsTrigger value="search" className="rounded-full px-6 data-[state=active]:bg-blue-50 data-[state=active]:text-blue-600">
                <Search className="w-4 h-4 mr-2" />
                Search
              </TabsTrigger>
              <TabsTrigger value="vocabulary" className="rounded-full px-6 data-[state=active]:bg-blue-50 data-[state=active]:text-blue-600">
                <BookOpen className="w-4 h-4 mr-2" />
                My List
              </TabsTrigger>
              <TabsTrigger value="speaking" className="rounded-full px-6 data-[state=active]:bg-blue-50 data-[state=active]:text-blue-600">
                <Mic className="w-4 h-4 mr-2" />
                Speaking
              </TabsTrigger>
            </TabsList>
          </div>

          {/* Search Tab */}
          <TabsContent value="search" className="space-y-6">
            <Card className="border-none shadow-sm overflow-hidden">
              <CardContent className="p-0">
                <form onSubmit={handleSearch} className="flex items-center p-2 bg-white">
                  <Input 
                    placeholder="Enter a word or phrase..." 
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="border-none focus-visible:ring-0 text-lg h-12"
                  />
                  <Button type="submit" disabled={searching} className="rounded-full px-6 bg-blue-600 hover:bg-blue-700">
                    {searching ? "Searching..." : "Look up"}
                  </Button>
                </form>
              </CardContent>
            </Card>

            <AnimatePresence mode="wait">
              {searchResult && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="space-y-6"
                >
                  <Card className="border-none shadow-sm">
                    <div className="md:flex">
                      <div className="flex-1">
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                          <div>
                            <CardTitle className="text-3xl font-bold text-blue-600">{searchResult.word}</CardTitle>
                            <CardDescription className="text-base mt-1">{searchResult.definition}</CardDescription>
                          </div>
                          <Button variant="outline" size="icon" onClick={() => speak(searchResult.word)} className="rounded-full">
                            <Volume2 className="w-5 h-5" />
                          </Button>
                        </CardHeader>
                        <CardContent className="space-y-6 pt-4">
                          <div>
                            <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-2">Usage</h4>
                            <p className="text-gray-700 leading-relaxed">{searchResult.usage}</p>
                          </div>
                          <Separator />
                          <div>
                            <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Example Sentences</h4>
                            <ul className="space-y-3">
                              {searchResult.examples.map((ex, i) => (
                                <li key={i} className="flex gap-3 items-start group">
                                  <div className="mt-1.5 w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
                                  <p className="text-gray-700 italic">"{ex}"</p>
                                  <Button 
                                    variant="ghost" 
                                    size="icon" 
                                    onClick={() => speak(ex)}
                                    className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                                  >
                                    <Volume2 className="w-3 h-3" />
                                  </Button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        </CardContent>
                      </div>
                      
                      {/* Image Section */}
                      <div className="md:w-64 p-6 flex flex-col items-center justify-center bg-gray-50/50 border-l border-gray-100">
                        <div className="w-full aspect-square rounded-2xl bg-white border border-gray-100 overflow-hidden flex items-center justify-center relative">
                          {wordImage ? (
                            <motion.img 
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              src={wordImage} 
                              alt={searchResult.word}
                              className="w-full h-full object-cover"
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <div className="flex flex-col items-center gap-2 text-gray-300">
                              <Play className="w-8 h-8 animate-pulse" />
                              <span className="text-[10px] uppercase tracking-widest font-bold">Generating...</span>
                            </div>
                          )}
                        </div>
                        <p className="text-[10px] text-gray-400 mt-4 text-center italic leading-tight">
                          AI-generated illustration to help you visualize the meaning.
                        </p>
                      </div>
                    </div>
                  </Card>

                  <Card className="border-none shadow-sm bg-blue-50/50">
                    <CardHeader>
                      <CardTitle className="text-lg flex items-center gap-2">
                        <Mic className="w-5 h-5 text-blue-600" />
                        Practice Pronunciation
                      </CardTitle>
                      <CardDescription>Record yourself saying "{searchResult.word}" to get AI feedback.</CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col items-center gap-6 py-8">
                      <Button 
                        size="lg" 
                        onClick={isRecording ? stopRecording : startRecording}
                        className={`w-20 h-20 rounded-full transition-all ${isRecording ? 'bg-red-500 hover:bg-red-600 animate-pulse' : 'bg-blue-600 hover:bg-blue-700'}`}
                      >
                        <Mic className="w-8 h-8 text-white" />
                      </Button>
                      
                      {feedback && (
                        <motion.div 
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          className="w-full max-w-md bg-white p-6 rounded-2xl shadow-sm border border-blue-100"
                        >
                          <div className="flex items-center justify-between mb-4">
                            <span className="text-sm font-medium text-gray-500">AI Score</span>
                            <Badge variant={feedback.score > 80 ? "default" : "secondary"} className={feedback.score > 80 ? "bg-green-100 text-green-700 hover:bg-green-100" : ""}>
                              {feedback.score}/100
                            </Badge>
                          </div>
                          <div className="w-full bg-gray-100 h-2 rounded-full overflow-hidden mb-4">
                            <div 
                              className={`h-full transition-all duration-1000 ${feedback.score > 80 ? 'bg-green-500' : 'bg-blue-500'}`}
                              style={{ width: `${feedback.score}%` }}
                            />
                          </div>
                          <p className="text-gray-700 text-sm leading-relaxed">
                            <CheckCircle2 className="w-4 h-4 inline mr-2 text-green-500" />
                            {feedback.feedback}
                          </p>
                        </motion.div>
                      )}
                    </CardContent>
                  </Card>
                </motion.div>
              )}
            </AnimatePresence>
          </TabsContent>

          {/* Vocabulary Tab */}
          <TabsContent value="vocabulary" className="space-y-6">
            {!user ? (
              <div className="text-center py-20 bg-white rounded-3xl border border-dashed border-gray-300">
                <BookOpen className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-gray-900">Sign in to save vocabulary</h3>
                <p className="text-gray-500 mt-2">Your personal learning list will appear here.</p>
                <Button onClick={loginWithGoogle} className="mt-6 bg-blue-600 hover:bg-blue-700">Sign In with Google</Button>
              </div>
            ) : vocabulary.length === 0 ? (
              <div className="text-center py-20 bg-white rounded-3xl border border-dashed border-gray-300">
                <Search className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-gray-900">Your list is empty</h3>
                <p className="text-gray-500 mt-2">Search for words to automatically save them here.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {vocabulary.map((item) => (
                  <Card key={item.id} className="border-none shadow-sm hover:shadow-md transition-shadow cursor-pointer group" onClick={() => {
                    setSearchResult(item);
                    setSearchQuery(item.word);
                  }}>
                    <CardHeader className="pb-2">
                      <div className="flex justify-between items-start">
                        <CardTitle className="text-xl text-blue-600">{item.word}</CardTitle>
                        <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
                          {new Date(item.createdAt?.seconds * 1000).toLocaleDateString()}
                        </Badge>
                      </div>
                      <CardDescription className="line-clamp-2">{item.definition}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-center gap-2 text-xs text-gray-400">
                        <div className="flex-1 h-1 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full bg-blue-400" style={{ width: `${item.masteryLevel}%` }} />
                        </div>
                        <span>Mastery: {item.masteryLevel}%</span>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* Speaking Tab */}
          <TabsContent value="speaking" className="space-y-6">
            <Card className="border-none shadow-sm overflow-hidden flex flex-col h-[600px]">
              <CardHeader className="bg-white border-b border-gray-100">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <MessageSquare className="w-5 h-5 text-blue-600" />
                      Role-play Practice
                    </CardTitle>
                    <CardDescription>Scenario: Ordering coffee at a busy cafe</CardDescription>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => setRoleplayMessages([])} className="text-xs">
                    Reset Chat
                  </Button>
                </div>
              </CardHeader>
              <ScrollArea className="flex-1 p-6 bg-gray-50/50">
                <div className="space-y-4">
                  {roleplayMessages.length === 0 && (
                    <div className="text-center py-10">
                      <p className="text-gray-400 text-sm">Start the conversation! Try saying "Hello, I'd like a latte please."</p>
                    </div>
                  )}
                  {roleplayMessages.map((msg, i) => (
                    <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[80%] p-4 rounded-2xl text-sm shadow-sm ${
                        msg.role === 'user' 
                          ? 'bg-blue-600 text-white rounded-tr-none' 
                          : 'bg-white text-gray-800 rounded-tl-none border border-gray-100'
                      }`}>
                        {msg.text}
                        {msg.role === 'model' && (
                          <Button variant="ghost" size="icon" onClick={() => speak(msg.text)} className="h-6 w-6 ml-2 text-gray-400 hover:text-blue-600">
                            <Volume2 className="w-3 h-3" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
              <div className="p-4 bg-white border-t border-gray-100">
                <div className="flex gap-2">
                  <Button 
                    variant="outline" 
                    size="icon" 
                    onClick={isRoleplayRecording ? stopRoleplayRecording : startRoleplayRecording}
                    className={`rounded-full shrink-0 ${isRoleplayRecording ? 'bg-red-50 border-red-200 text-red-600 animate-pulse' : ''}`}
                  >
                    <Mic className="w-4 h-4" />
                  </Button>
                  <Input 
                    placeholder="Type or speak your response..." 
                    value={userMessage}
                    onChange={(e) => setUserMessage(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleRoleplaySend()}
                    className="border-gray-200 focus-visible:ring-blue-600"
                  />
                  <Button onClick={() => handleRoleplaySend()} className="bg-blue-600 hover:bg-blue-700">
                    Send
                  </Button>
                </div>
              </div>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
