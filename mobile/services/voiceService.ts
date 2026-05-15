import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Voice services run on :8000 as an external EchoPay v1 dependency — separate
// from the echopay-cash backend on :8100. We resolve the base URL from
// EXPO_PUBLIC_VOICE_BASE_URL (inlined at build time by Metro). Soft default
// to http://localhost:8000 because the voice stack is an optional external
// service that may legitimately be offline during dev — failing hard at
// module load would break every screen, not just voice features.
const VOICE_BASE_URL_DEFAULT = 'http://localhost:8000';
const ECHOPAY_API_URL =
  (process.env.EXPO_PUBLIC_VOICE_BASE_URL as string | undefined) ??
  VOICE_BASE_URL_DEFAULT;

if (!process.env.EXPO_PUBLIC_VOICE_BASE_URL) {
  // Fires once at module load (top-level), not per request — single line
  // even when voiceService is imported by multiple screens.
  console.warn(
    '[VoiceService] EXPO_PUBLIC_VOICE_BASE_URL not set; falling back to ' +
      `${VOICE_BASE_URL_DEFAULT}. On a physical phone you must set this to ` +
      'your dev machine LAN IP (e.g. http://192.168.1.42:8000).',
  );
} else {
  console.log('[VoiceService] Using API URL:', ECHOPAY_API_URL);
}

// Voice API response types
export interface VoiceResponse {
  success: boolean;
  session_id: string;
  intent: string;
  transcript?: string; // What the user said (transcribed text)
  response_text: string;
  response_audio?: string; // base64 encoded audio
  action: string;
  data?: {
    transfer_id?: string;
    recipient_name?: string;
    recipient?: string; // Alternative field name for recipient
    amount?: number;
    fee?: number;
    total?: number;
    balance?: number;
    recipients?: Array<{ name: string; account_number: string }>;
    transactions?: Array<{ description: string; amount: number; date: string }>;
  };
  error?: string;
}

export interface TranscriptionResponse {
  success: boolean;
  transcript: string;
  confidence?: number;
  provider?: string; // 'google' or 'whisper'
  error?: string;
}

// Voice service for EchoPay
class VoiceService {
  private sessionId: string | null = null;
  private companyId: string = '1'; // Demo bank company ID
  private accountNumber: string | null = null;

  // Set user context for voice requests
  async setUserContext(accountNumber: string, companyId?: string) {
    this.accountNumber = accountNumber;
    if (companyId) this.companyId = companyId;
  }

  // Get or create session ID
  private async getSessionId(): Promise<string> {
    if (!this.sessionId) {
      this.sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    return this.sessionId;
  }

  // Get auth token from storage
  private async getToken(): Promise<string | null> {
    return await AsyncStorage.getItem('token');
  }

  // Process audio through EchoPay voice API
  async processAudio(audioUri: string): Promise<VoiceResponse> {
    try {
      const sessionId = await this.getSessionId();
      const token = await this.getToken();

      // Note: We send the file directly via FormData, no need to read as base64

      // Create form data with audio file
      const formData = new FormData();
      formData.append('audio', {
        uri: audioUri,
        type: 'audio/m4a',
        name: 'recording.m4a',
      } as any);

      const response = await axios.post<VoiceResponse>(
        `${ECHOPAY_API_URL}/api/v1/voice/process-audio`,
        formData,
        {
          headers: {
            'Content-Type': 'multipart/form-data',
            'account-number': this.accountNumber || '',
            'company-id': this.companyId,
            'session-id': sessionId,
            'token': token || '',
            'include-audio': 'true',
          },
          timeout: 60000, // 60 second timeout for full voice pipeline
        }
      );

      return response.data;
    } catch (error: any) {
      console.error('Voice processing error:', error);
      return {
        success: false,
        session_id: this.sessionId || '',
        intent: 'error',
        response_text: error.response?.data?.detail || 'Failed to process voice command. Please try again.',
        action: 'retry',
        error: error.message,
      };
    }
  }

  // Transcribe audio using Google Speech (Nigerian English optimized)
  async transcribeAudio(audioUri: string): Promise<TranscriptionResponse> {
    try {
      const formData = new FormData();
      formData.append('audio', {
        uri: audioUri,
        type: 'audio/m4a',
        name: 'recording.m4a',
      } as any);

      const response = await axios.post<TranscriptionResponse>(
        `${ECHOPAY_API_URL}/api/v1/voice/transcribe`,
        formData,
        {
          headers: {
            'Content-Type': 'multipart/form-data',
            'language': 'en-NG', // Nigerian English
          },
          timeout: 30000, // 30 second timeout for transcription
        }
      );

      console.log(`[VoiceService] Transcribed with ${response.data.provider}: "${response.data.transcript}"`);
      return response.data;
    } catch (error: any) {
      console.error('Transcription error:', error);
      return {
        success: false,
        transcript: '',
        confidence: 0,
        provider: 'none',
        error: error.message,
      };
    }
  }

  // Process audio with Google Speech transcription + command processing
  async processAudioWithGoogleSpeech(audioUri: string): Promise<VoiceResponse> {
    try {
      // Step 1: Transcribe with Google Speech (Nigerian English)
      const transcription = await this.transcribeAudio(audioUri);

      if (!transcription.success || !transcription.transcript) {
        return {
          success: false,
          session_id: this.sessionId || '',
          intent: 'error',
          response_text: 'I couldn\'t understand that. Please try again.',
          action: 'retry',
          error: transcription.error || 'Transcription failed',
        };
      }

      console.log(`[VoiceService] Transcription (${transcription.provider}): "${transcription.transcript}"`);

      // Step 2: Process the transcribed text
      return await this.processText(transcription.transcript);
    } catch (error: any) {
      console.error('Audio processing error:', error);
      return {
        success: false,
        session_id: this.sessionId || '',
        intent: 'error',
        response_text: 'Failed to process voice command. Please try again.',
        action: 'retry',
        error: error.message,
      };
    }
  }

  // Process text command (for testing/accessibility)
  async processText(text: string): Promise<VoiceResponse> {
    try {
      const sessionId = await this.getSessionId();
      const token = await this.getToken();

      const response = await axios.post<VoiceResponse>(
        `${ECHOPAY_API_URL}/api/v1/voice/process-text`,
        {
          text,
          account_number: this.accountNumber,
          company_id: parseInt(this.companyId),
          session_id: sessionId,
          token: token,
          include_audio: true,
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 60000, // 60 second timeout
        }
      );

      return response.data;
    } catch (error: any) {
      console.error('Text processing error:', error);
      return {
        success: false,
        session_id: this.sessionId || '',
        intent: 'error',
        response_text: error.response?.data?.detail || 'Failed to process command. Please try again.',
        action: 'retry',
        error: error.message,
      };
    }
  }

  // Get TTS audio for text
  async getTextToSpeech(text: string, voice: string = 'nova'): Promise<string | null> {
    try {
      const response = await axios.post(
        `${ECHOPAY_API_URL}/api/v1/voice/tts`,
        {
          text,
          voice,
          speed: 1.0,
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );

      if (response.data.success) {
        return response.data.audio_base64;
      }
      return null;
    } catch (error) {
      console.error('TTS error:', error);
      return null;
    }
  }

  // Clear current session
  async clearSession(): Promise<void> {
    try {
      if (this.sessionId) {
        await axios.post(
          `${ECHOPAY_API_URL}/api/v1/voice/session/clear`,
          { session_id: this.sessionId },
          {
            headers: {
              'Content-Type': 'application/json',
            },
          }
        );
      }
    } catch (error) {
      console.error('Session clear error:', error);
    } finally {
      this.sessionId = null;
    }
  }

  // Check provider status (Gemini/GPT-4 availability)
  async checkProviderStatus(): Promise<{ gemini: boolean; gpt4: boolean }> {
    try {
      const response = await axios.get(
        `${ECHOPAY_API_URL}/api/v1/voice/provider-status`,
        { timeout: 5000 }
      );
      return response.data;
    } catch (error) {
      return { gemini: false, gpt4: false };
    }
  }
}

// ============================================================================
// VOICE BIOMETRICS API
// ============================================================================

export interface EnrollmentResponse {
  success: boolean;
  enrollment_id?: string;
  quality_score?: number;
  samples_used?: number;
  message: string;
  error?: string;
}

export interface VerificationResponse {
  verified: boolean;
  confidence: number;
  similarity?: number;
  security_level?: string;
  message: string;
  error?: string;
}

export interface VoiceProfileResponse {
  success: boolean;
  data?: {
    user_id: string;
    enrollment_id: string;
    quality_score: number;
    samples_count: number;
    enrollment_date: string;
    last_verified: string | null;
    verification_count: number;
    failed_verification_count: number;
    is_active: boolean;
    locked_until: string | null;
  };
}

class VoiceBiometricsService {
  // Enroll voice with 3-5 audio samples
  async enrollVoice(
    audioUris: string[],
    accountNumber: string,
    companyId: string = '1'
  ): Promise<EnrollmentResponse> {
    try {
      if (audioUris.length < 3) {
        return {
          success: false,
          message: 'At least 3 voice samples required',
          error: 'INSUFFICIENT_SAMPLES'
        };
      }

      const formData = new FormData();

      // Add required samples (3)
      for (let i = 0; i < Math.min(audioUris.length, 5); i++) {
        formData.append(`sample_${i + 1}`, {
          uri: audioUris[i],
          type: 'audio/m4a',
          name: `sample_${i + 1}.m4a`,
        } as any);
      }

      const response = await axios.post<EnrollmentResponse>(
        `${ECHOPAY_API_URL}/api/v1/voice/biometrics/enroll`,
        formData,
        {
          headers: {
            'Content-Type': 'multipart/form-data',
            'account-number': accountNumber,
            'company-id': companyId,
          },
          timeout: 120000, // 2 minutes for processing multiple samples
        }
      );

      return response.data;
    } catch (error: any) {
      console.error('Voice enrollment error:', error);
      const errorData = error.response?.data;
      return {
        success: false,
        message: errorData?.message || 'Failed to enroll voice. Please try again.',
        error: errorData?.error || error.message,
      };
    }
  }

  // Verify voice against stored profile
  async verifyVoice(
    audioUri: string,
    accountNumber: string,
    companyId: string = '1'
  ): Promise<VerificationResponse> {
    try {
      const formData = new FormData();
      formData.append('audio', {
        uri: audioUri,
        type: 'audio/m4a',
        name: 'verification.m4a',
      } as any);

      const response = await axios.post<VerificationResponse>(
        `${ECHOPAY_API_URL}/api/v1/voice/biometrics/verify`,
        formData,
        {
          headers: {
            'Content-Type': 'multipart/form-data',
            'account-number': accountNumber,
            'company-id': companyId,
          },
          timeout: 60000, // 1 minute timeout
        }
      );

      return response.data;
    } catch (error: any) {
      console.error('Voice verification error:', error);
      const errorData = error.response?.data;
      return {
        verified: false,
        confidence: 0,
        message: errorData?.message || 'Voice verification failed. Please try again.',
        error: errorData?.error || error.message,
      };
    }
  }

  // Get voice profile status
  async getVoiceProfile(
    accountNumber: string,
    companyId?: string
  ): Promise<VoiceProfileResponse> {
    try {
      const params = companyId ? `?company_id=${companyId}` : '';
      const response = await axios.get<VoiceProfileResponse>(
        `${ECHOPAY_API_URL}/api/v1/voice/biometrics/profile/${accountNumber}${params}`,
        { timeout: 10000 }
      );
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 404) {
        return {
          success: false,
          data: undefined,
        };
      }
      throw error;
    }
  }

  // Delete voice profile
  async deleteVoiceProfile(
    accountNumber: string,
    companyId?: string
  ): Promise<{ success: boolean; message: string }> {
    try {
      const params = companyId ? `?company_id=${companyId}` : '';
      const response = await axios.delete(
        `${ECHOPAY_API_URL}/api/v1/voice/biometrics/profile/${accountNumber}${params}`,
        { timeout: 10000 }
      );
      return response.data;
    } catch (error: any) {
      return {
        success: false,
        message: error.response?.data?.detail || 'Failed to delete voice profile',
      };
    }
  }
}

export const voiceBiometricsService = new VoiceBiometricsService();
export const voiceService = new VoiceService();
export default voiceService;
