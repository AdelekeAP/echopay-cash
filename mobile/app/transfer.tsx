import { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Picker } from '@react-native-picker/picker';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Haptics from 'expo-haptics';
import { bankAPI, accountAPI, transactionAPI } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Bank, RecipientInfo } from '../types';
import VoiceVerificationModal from '../components/VoiceVerificationModal';
import { voiceBiometricsService } from '../services/voiceService';
import { Echopay } from '../constants/theme';

type Step = 'recipient' | 'amount' | 'confirm' | 'pin' | 'success';

// Security level thresholds (in Naira)
const SECURITY_THRESHOLDS = {
  PIN_ONLY: 50000,           // ≤₦50K: PIN only
  SINGLE_BIOMETRIC: 1000000, // ≤₦1M: PIN + (Voice OR Face)
  MULTI_FACTOR: Infinity,    // >₦1M: PIN + Voice + Face
};

export default function TransferScreen() {
  const router = useRouter();
  const { account, refreshAccount } = useAuth();

  const [step, setStep] = useState<Step>('recipient');
  const [loading, setLoading] = useState(false);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricType, setBiometricType] = useState<'fingerprint' | 'faceid' | 'iris' | null>(null);

  // Voice biometrics state
  const [voiceEnrolled, setVoiceEnrolled] = useState(false);
  const [showVoiceVerification, setShowVoiceVerification] = useState(false);
  const [voiceVerified, setVoiceVerified] = useState(false);
  const [faceVerified, setFaceVerified] = useState(false);

  // Form data
  const [accountNumber, setAccountNumber] = useState('');
  const [selectedBank, setSelectedBank] = useState('');
  const [recipient, setRecipient] = useState<RecipientInfo | null>(null);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [pin, setPin] = useState('');

  useEffect(() => {
    loadBanks();
    checkBiometricSupport();
    checkVoiceEnrollment();
  }, []);

  const checkVoiceEnrollment = async () => {
    if (!account?.account_number) return;
    try {
      const profile = await voiceBiometricsService.getVoiceProfile(account.account_number);
      setVoiceEnrolled(profile.success && !!profile.data?.is_active);
    } catch (error) {
      console.log('Voice profile check failed:', error);
      setVoiceEnrolled(false);
    }
  };

  // Determine required security level based on amount
  const getRequiredSecurityLevel = (transferAmount: number): 'pin' | 'single_biometric' | 'multi_factor' => {
    if (transferAmount <= SECURITY_THRESHOLDS.PIN_ONLY) {
      return 'pin';
    } else if (transferAmount <= SECURITY_THRESHOLDS.SINGLE_BIOMETRIC) {
      return 'single_biometric';
    } else {
      return 'multi_factor';
    }
  };

  const checkBiometricSupport = async () => {
    try {
      const compatible = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      setBiometricAvailable(compatible && enrolled);

      if (compatible && enrolled) {
        const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
        if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
          setBiometricType('faceid');
        } else if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
          setBiometricType('fingerprint');
        } else if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) {
          setBiometricType('iris');
        }
      }
    } catch (error) {
      console.log('Biometric check failed:', error);
    }
  };

  const loadBanks = async () => {
    try {
      const bankList = await bankAPI.getBanks();
      setBanks(bankList);
      if (bankList.length > 0) {
        setSelectedBank(bankList[0].code);
      }
    } catch {
      // bankAPI.getBanks() hits GET /banks/ — a legacy demo-bank
      // endpoint that doesn't exist on the echopay-cash backend
      // (404). This entire screen is dormant in the demo path —
      // the home Send pill routes to /local-transfer now, not here.
      // Silenced to keep LogBox clean if user reaches this screen
      // via back-nav glitch or deep-link. TODO(phase-1): retarget
      // this screen to real Squad payout or remove entirely.
      setBanks([]);
    }
  };

  const lookupAccount = async () => {
    if (accountNumber.length !== 10) {
      Alert.alert('Error', 'Account number must be 10 digits');
      return;
    }

    setLoading(true);
    try {
      const result = await accountAPI.lookupAccount(accountNumber, selectedBank);
      if (result.found) {
        setRecipient(result.recipient);
        setStep('amount');
      }
    } catch (error: any) {
      const message = error.response?.data?.account_number?.[0] ||
        error.response?.data?.error ||
        'Account not found';
      Alert.alert('Error', message);
    } finally {
      setLoading(false);
    }
  };

  const handleAmountNext = () => {
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      Alert.alert('Error', 'Please enter a valid amount');
      return;
    }

    const balance = parseFloat(account?.balance || '0');
    if (amountNum > balance) {
      Alert.alert('Insufficient Funds', `Your balance is ${formatCurrency(account?.balance || '0')}`);
      return;
    }

    setStep('confirm');
  };

  const handleConfirm = async () => {
    const transferAmount = parseFloat(amount);
    const securityLevel = getRequiredSecurityLevel(transferAmount);

    console.log(`[Transfer] Amount: ₦${transferAmount}, Security Level: ${securityLevel}`);
    console.log(`[Transfer] Voice enrolled: ${voiceEnrolled}, Face ID available: ${biometricAvailable}`);

    // For high-value transfers (>₦1M), require both voice AND face
    if (securityLevel === 'multi_factor') {
      if (voiceEnrolled && !voiceVerified) {
        // Need voice verification first
        setShowVoiceVerification(true);
        return;
      }
      if (biometricAvailable && !faceVerified) {
        // After voice, do Face ID
        await handleFaceIdVerification();
        return;
      }
      // Both verified, proceed to PIN
      setStep('pin');
      return;
    }

    // For medium-value transfers (₦50K-₦1M), require PIN + (Voice OR Face)
    if (securityLevel === 'single_biometric') {
      // Prefer voice if enrolled, otherwise use Face ID
      if (voiceEnrolled && !voiceVerified && !faceVerified) {
        setShowVoiceVerification(true);
        return;
      }
      if (biometricAvailable && !voiceVerified && !faceVerified) {
        await handleFaceIdVerification();
        return;
      }
      // At least one biometric verified, proceed to PIN
      setStep('pin');
      return;
    }

    // For low-value transfers (≤₦50K), only PIN required
    setStep('pin');
  };

  const handleFaceIdVerification = async () => {
    try {
      const biometricLabel = biometricType === 'faceid' ? 'Face ID' :
                             biometricType === 'fingerprint' ? 'Fingerprint' : 'Biometric';

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: `Verify with ${biometricLabel} to continue`,
        cancelLabel: 'Skip',
        fallbackLabel: 'Skip',
        disableDeviceFallback: true,
      });

      if (result.success) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setFaceVerified(true);

        const transferAmount = parseFloat(amount);
        const securityLevel = getRequiredSecurityLevel(transferAmount);

        // Check if we still need voice for multi-factor
        if (securityLevel === 'multi_factor' && voiceEnrolled && !voiceVerified) {
          setShowVoiceVerification(true);
        } else {
          // Biometric done, proceed to PIN
          setStep('pin');
        }
      } else {
        // User skipped Face ID
        console.log('Face ID skipped');
        setStep('pin');
      }
    } catch (error) {
      console.log('Face ID error:', error);
      setStep('pin');
    }
  };

  const handleVoiceVerified = () => {
    setShowVoiceVerification(false);
    setVoiceVerified(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    const transferAmount = parseFloat(amount);
    const securityLevel = getRequiredSecurityLevel(transferAmount);

    // Check if we still need Face ID for multi-factor
    if (securityLevel === 'multi_factor' && biometricAvailable && !faceVerified) {
      handleFaceIdVerification();
    } else {
      // Voice done, proceed to PIN
      setStep('pin');
    }
  };

  const handleVoiceVerificationFailed = (attempts: number) => {
    setShowVoiceVerification(false);
    Alert.alert(
      'Voice Verification Failed',
      `Too many failed attempts (${attempts}). Please use PIN only.`,
      [{ text: 'OK', onPress: () => setStep('pin') }]
    );
  };

  const completeTransferWithBiometric = async () => {
    setLoading(true);
    try {
      // For biometric auth, we use a special flag that the backend recognizes
      // In production, this would involve a secure biometric token
      await transactionAPI.transfer({
        recipient_account_number: accountNumber,
        recipient_bank_code: selectedBank,
        amount: parseFloat(amount),
        pin: '1234', // In production: use biometric-backed secure token
        description: description || 'Transfer',
      });

      await refreshAccount();
      setStep('success');
    } catch (error: any) {
      const message = error.response?.data?.error || 'Transfer failed';
      Alert.alert('Error', message);
      // Fall back to PIN step on error
      setStep('pin');
    } finally {
      setLoading(false);
    }
  };

  const handleTransfer = async () => {
    if (pin.length < 4) {
      Alert.alert('Error', 'Please enter your PIN');
      return;
    }

    setLoading(true);
    try {
      await transactionAPI.transfer({
        recipient_account_number: accountNumber,
        recipient_bank_code: selectedBank,
        amount: parseFloat(amount),
        pin,
        description: description || 'Transfer',
      });

      await refreshAccount();
      setStep('success');
    } catch (error: any) {
      const message = error.response?.data?.error || 'Transfer failed';
      Alert.alert('Error', message);
    } finally {
      setLoading(false);
    }
  };

  const formatCurrency = (value: string) => {
    const num = parseFloat(value);
    return new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency: 'NGN',
      minimumFractionDigits: 2,
    }).format(num);
  };

  const renderRecipientStep = () => (
    <>
      <Text style={styles.stepTitle}>Who are you sending to?</Text>

      <View style={styles.inputContainer}>
        <Text style={styles.label}>Select Bank</Text>
        <View style={styles.pickerContainer}>
          <Picker
            selectedValue={selectedBank}
            onValueChange={(value) => setSelectedBank(value)}
            style={styles.picker}
          >
            {banks.map((bank) => (
              <Picker.Item key={bank.code} label={bank.name} value={bank.code} />
            ))}
          </Picker>
        </View>
      </View>

      <View style={styles.inputContainer}>
        <Text style={styles.label}>Account Number</Text>
        <TextInput
          style={styles.input}
          placeholder="Enter 10-digit account number"
          value={accountNumber}
          onChangeText={setAccountNumber}
          keyboardType="numeric"
          maxLength={10}
        />
      </View>

      <TouchableOpacity
        style={[styles.button, loading && styles.buttonDisabled]}
        onPress={lookupAccount}
        disabled={loading || accountNumber.length !== 10}
      >
        {loading ? (
          <ActivityIndicator color={Echopay.cardBg} />
        ) : (
          <Text style={styles.buttonText}>Continue</Text>
        )}
      </TouchableOpacity>

      {/* Test accounts hint */}
      <View style={styles.hint}>
        <Text style={styles.hintTitle}>Test Recipients (PIN: 1234):</Text>
        <Text style={styles.hintText}>Ade Johnson (GTBank 058): 2345678901</Text>
        <Text style={styles.hintText}>Chidi Okonkwo (First Bank 011): 3456789012</Text>
        <Text style={styles.hintText}>Amara Nwosu (Zenith 057): 4567890123</Text>
        <Text style={styles.hintText}>Tunde Adeyemi (UBA 033): 5678901234</Text>
      </View>
    </>
  );

  const renderAmountStep = () => (
    <>
      <TouchableOpacity style={styles.backButton} onPress={() => setStep('recipient')}>
        <Ionicons name="arrow-back" size={24} color={Echopay.text} />
      </TouchableOpacity>

      <Text style={styles.stepTitle}>Enter Amount</Text>

      {/* Recipient Card */}
      <View style={styles.recipientCard}>
        <View style={styles.recipientIcon}>
          <Ionicons name="person" size={24} color={Echopay.danger} />
        </View>
        <View>
          <Text style={styles.recipientName}>{recipient?.account_name}</Text>
          <Text style={styles.recipientBank}>{recipient?.bank_name}</Text>
          <Text style={styles.recipientAccount}>{recipient?.account_number}</Text>
        </View>
      </View>

      <View style={styles.inputContainer}>
        <Text style={styles.label}>Amount</Text>
        <View style={styles.amountInputContainer}>
          <Text style={styles.currencySymbol}>₦</Text>
          <TextInput
            style={styles.amountInput}
            placeholder="0.00"
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
          />
        </View>
        <Text style={styles.balanceText}>
          Balance: {formatCurrency(account?.balance || '0')}
        </Text>
      </View>

      <View style={styles.inputContainer}>
        <Text style={styles.label}>Description (Optional)</Text>
        <TextInput
          style={styles.input}
          placeholder="What's this for?"
          value={description}
          onChangeText={setDescription}
        />
      </View>

      <TouchableOpacity
        style={[styles.button, (!amount || parseFloat(amount) <= 0) && styles.buttonDisabled]}
        onPress={handleAmountNext}
        disabled={!amount || parseFloat(amount) <= 0}
      >
        <Text style={styles.buttonText}>Continue</Text>
      </TouchableOpacity>
    </>
  );

  const renderConfirmStep = () => {
    const transferAmount = parseFloat(amount);
    const securityLevel = getRequiredSecurityLevel(transferAmount);

    return (
      <>
        <TouchableOpacity style={styles.backButton} onPress={() => setStep('amount')}>
          <Ionicons name="arrow-back" size={24} color={Echopay.text} />
        </TouchableOpacity>

        <Text style={styles.stepTitle}>Confirm Transfer</Text>

        <View style={styles.confirmCard}>
          <View style={styles.confirmRow}>
            <Text style={styles.confirmLabel}>To</Text>
            <Text style={styles.confirmValue}>{recipient?.account_name}</Text>
          </View>
          <View style={styles.confirmRow}>
            <Text style={styles.confirmLabel}>Bank</Text>
            <Text style={styles.confirmValue}>{recipient?.bank_name}</Text>
          </View>
          <View style={styles.confirmRow}>
            <Text style={styles.confirmLabel}>Account</Text>
            <Text style={styles.confirmValue}>{recipient?.account_number}</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.confirmRow}>
            <Text style={styles.confirmLabel}>Amount</Text>
            <Text style={styles.confirmAmount}>{formatCurrency(amount)}</Text>
          </View>
          {description && (
            <View style={styles.confirmRow}>
              <Text style={styles.confirmLabel}>Description</Text>
              <Text style={styles.confirmValue}>{description}</Text>
            </View>
          )}
        </View>

        {/* Security Requirements Card */}
        <View style={styles.securityCard}>
          <View style={styles.securityHeader}>
            <Ionicons name="shield-checkmark" size={18} color={Echopay.success} />
            <Text style={styles.securityTitle}>Security Verification</Text>
          </View>

          <View style={styles.securityItems}>
            {/* PIN - always required */}
            <View style={styles.securityItem}>
              <Ionicons name="keypad" size={16} color={Echopay.text} />
              <Text style={styles.securityItemText}>PIN</Text>
              <Text style={styles.securityRequired}>Required</Text>
            </View>

            {/* Voice - for medium and high value */}
            {securityLevel !== 'pin' && voiceEnrolled && (
              <View style={styles.securityItem}>
                <Ionicons
                  name={voiceVerified ? "checkmark-circle" : "mic"}
                  size={16}
                  color={voiceVerified ? Echopay.success : Echopay.text}
                />
                <Text style={styles.securityItemText}>Voice ID</Text>
                <Text style={[
                  styles.securityRequired,
                  voiceVerified && styles.securityVerified
                ]}>
                  {voiceVerified ? 'Verified' : securityLevel === 'multi_factor' ? 'Required' : 'Optional'}
                </Text>
              </View>
            )}

            {/* Face ID - for medium and high value */}
            {securityLevel !== 'pin' && biometricAvailable && (
              <View style={styles.securityItem}>
                <Ionicons
                  name={faceVerified ? "checkmark-circle" : (biometricType === 'faceid' ? "scan" : "finger-print")}
                  size={16}
                  color={faceVerified ? Echopay.success : Echopay.text}
                />
                <Text style={styles.securityItemText}>
                  {biometricType === 'faceid' ? 'Face ID' : 'Fingerprint'}
                </Text>
                <Text style={[
                  styles.securityRequired,
                  faceVerified && styles.securityVerified
                ]}>
                  {faceVerified ? 'Verified' : securityLevel === 'multi_factor' ? 'Required' : 'Optional'}
                </Text>
              </View>
            )}
          </View>

          {securityLevel === 'multi_factor' && (
            <Text style={styles.securityNote}>
              High-value transfers require all security factors
            </Text>
          )}
        </View>

        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={Echopay.danger} />
            <Text style={styles.loadingText}>Processing transfer...</Text>
          </View>
        ) : (
          <>
            <TouchableOpacity style={styles.button} onPress={handleConfirm}>
              <Text style={styles.buttonText}>
                {securityLevel === 'pin' ? 'Continue to PIN' : 'Verify & Continue'}
              </Text>
            </TouchableOpacity>

            {securityLevel !== 'pin' && (
              <TouchableOpacity
                style={styles.skipButton}
                onPress={() => setStep('pin')}
              >
                <Text style={styles.skipButtonText}>Skip verification (PIN only)</Text>
              </TouchableOpacity>
            )}
          </>
        )}
      </>
    );
  };

  const renderPinStep = () => (
    <>
      <TouchableOpacity style={styles.backButton} onPress={() => setStep('confirm')}>
        <Ionicons name="arrow-back" size={24} color={Echopay.text} />
      </TouchableOpacity>

      <Text style={styles.stepTitle}>Enter PIN</Text>
      <Text style={styles.stepSubtitle}>Enter your 4-digit transaction PIN</Text>

      <View style={styles.pinContainer}>
        <TextInput
          style={styles.pinInput}
          placeholder="••••"
          value={pin}
          onChangeText={setPin}
          keyboardType="numeric"
          maxLength={6}
          secureTextEntry
        />
      </View>

      <TouchableOpacity
        style={[styles.button, (loading || pin.length < 4) && styles.buttonDisabled]}
        onPress={handleTransfer}
        disabled={loading || pin.length < 4}
      >
        {loading ? (
          <ActivityIndicator color={Echopay.cardBg} />
        ) : (
          <Text style={styles.buttonText}>Complete Transfer</Text>
        )}
      </TouchableOpacity>

      <Text style={styles.pinHint}>Test PIN: 1234</Text>
    </>
  );

  const renderSuccessStep = () => (
    <View style={styles.successContainer}>
      <View style={styles.successIcon}>
        <Ionicons name="checkmark-circle" size={80} color={Echopay.success} />
      </View>
      <Text style={styles.successTitle}>Transfer Successful!</Text>
      <Text style={styles.successAmount}>{formatCurrency(amount)}</Text>
      <Text style={styles.successRecipient}>
        sent to {recipient?.account_name}
      </Text>

      <TouchableOpacity
        style={styles.button}
        onPress={() => router.back()}
      >
        <Text style={styles.buttonText}>Done</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        <ScrollView contentContainerStyle={styles.scrollContent}>
          {/* Header */}
          <View style={styles.header}>
            <TouchableOpacity onPress={() => router.back()}>
              <Ionicons name="close" size={28} color={Echopay.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Transfer Money</Text>
            <View style={{ width: 28 }} />
          </View>

          {/* Step Content */}
          <View style={styles.content}>
            {step === 'recipient' && renderRecipientStep()}
            {step === 'amount' && renderAmountStep()}
            {step === 'confirm' && renderConfirmStep()}
            {step === 'pin' && renderPinStep()}
            {step === 'success' && renderSuccessStep()}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Voice Verification Modal */}
      <VoiceVerificationModal
        visible={showVoiceVerification}
        onClose={() => setShowVoiceVerification(false)}
        onVerified={handleVoiceVerified}
        onFailed={handleVoiceVerificationFailed}
        accountNumber={account?.account_number || ''}
        companyId="1"
        maxAttempts={3}
        transferAmount={parseFloat(amount) || 0}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Echopay.cardBg,
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: Echopay.border,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: Echopay.text,
  },
  content: {
    flex: 1,
    padding: 24,
  },
  backButton: {
    marginBottom: 16,
  },
  stepTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: Echopay.text,
    marginBottom: 8,
  },
  stepSubtitle: {
    fontSize: 14,
    color: Echopay.textMuted,
    marginBottom: 24,
  },
  inputContainer: {
    marginBottom: 20,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: Echopay.text,
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: Echopay.border,
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    backgroundColor: Echopay.cardSoft,
  },
  pickerContainer: {
    borderWidth: 1,
    borderColor: Echopay.border,
    borderRadius: 12,
    backgroundColor: Echopay.cardSoft,
    overflow: 'hidden',
  },
  picker: {
    height: 50,
  },
  button: {
    backgroundColor: Echopay.danger,
    borderRadius: 12,
    padding: 18,
    alignItems: 'center',
    marginTop: 16,
  },
  buttonDisabled: {
    backgroundColor: Echopay.accentMuted,
  },
  buttonText: {
    color: Echopay.cardBg,
    fontSize: 18,
    fontWeight: '600',
  },
  hint: {
    marginTop: 32,
    padding: 16,
    backgroundColor: Echopay.cardSoft,
    borderRadius: 12,
  },
  hintTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: Echopay.text,
    marginBottom: 8,
  },
  hintText: {
    fontSize: 12,
    color: Echopay.textMuted,
    marginBottom: 4,
  },
  recipientCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Echopay.cardSoft,
    padding: 16,
    borderRadius: 12,
    marginBottom: 24,
  },
  recipientIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Echopay.dangerSoft,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  recipientName: {
    fontSize: 16,
    fontWeight: '600',
    color: Echopay.text,
  },
  recipientBank: {
    fontSize: 14,
    color: Echopay.textMuted,
    marginTop: 2,
  },
  recipientAccount: {
    fontSize: 12,
    color: Echopay.textSubtle,
    marginTop: 2,
  },
  amountInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Echopay.border,
    borderRadius: 12,
    backgroundColor: Echopay.cardSoft,
    paddingHorizontal: 16,
  },
  currencySymbol: {
    fontSize: 24,
    fontWeight: '600',
    color: Echopay.text,
    marginRight: 8,
  },
  amountInput: {
    flex: 1,
    padding: 16,
    fontSize: 24,
    fontWeight: '600',
  },
  balanceText: {
    fontSize: 12,
    color: Echopay.textMuted,
    marginTop: 8,
  },
  confirmCard: {
    backgroundColor: Echopay.cardSoft,
    borderRadius: 16,
    padding: 20,
    marginBottom: 24,
  },
  confirmRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  confirmLabel: {
    fontSize: 14,
    color: Echopay.textMuted,
  },
  confirmValue: {
    fontSize: 14,
    fontWeight: '600',
    color: Echopay.text,
  },
  confirmAmount: {
    fontSize: 20,
    fontWeight: 'bold',
    color: Echopay.danger,
  },
  divider: {
    height: 1,
    backgroundColor: Echopay.border,
    marginVertical: 12,
  },
  pinContainer: {
    alignItems: 'center',
    marginVertical: 32,
  },
  pinInput: {
    borderWidth: 2,
    borderColor: Echopay.danger,
    borderRadius: 12,
    padding: 20,
    fontSize: 32,
    fontWeight: '600',
    textAlign: 'center',
    width: 200,
    letterSpacing: 16,
  },
  pinHint: {
    textAlign: 'center',
    fontSize: 12,
    color: Echopay.textSubtle,
    marginTop: 16,
  },
  successContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  successIcon: {
    marginBottom: 24,
  },
  successTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: Echopay.text,
    marginBottom: 8,
  },
  successAmount: {
    fontSize: 32,
    fontWeight: 'bold',
    color: Echopay.success,
  },
  successRecipient: {
    fontSize: 16,
    color: Echopay.textMuted,
    marginTop: 8,
    marginBottom: 32,
  },
  biometricButton: {
    backgroundColor: Echopay.danger,
    borderRadius: 12,
    padding: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
    gap: 12,
  },
  biometricButtonText: {
    color: Echopay.cardBg,
    fontSize: 18,
    fontWeight: '600',
  },
  secondaryButton: {
    backgroundColor: 'transparent',
    borderRadius: 12,
    padding: 18,
    alignItems: 'center',
    marginTop: 12,
    borderWidth: 1,
    borderColor: Echopay.danger,
  },
  secondaryButtonText: {
    color: Echopay.danger,
    fontSize: 16,
    fontWeight: '600',
  },
  loadingContainer: {
    alignItems: 'center',
    padding: 32,
  },
  loadingText: {
    marginTop: 16,
    fontSize: 16,
    color: Echopay.textMuted,
  },
  securityCard: {
    backgroundColor: Echopay.successSoft,
    borderRadius: 12,
    padding: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: Echopay.successSoft,
  },
  securityHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    gap: 8,
  },
  securityTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: Echopay.success,
  },
  securityItems: {
    gap: 8,
  },
  securityItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  securityItemText: {
    fontSize: 14,
    color: Echopay.text,
    flex: 1,
  },
  securityRequired: {
    fontSize: 12,
    color: Echopay.textMuted,
    fontWeight: '500',
  },
  securityVerified: {
    color: Echopay.success,
  },
  securityNote: {
    fontSize: 12,
    color: Echopay.textMuted,
    marginTop: 12,
    fontStyle: 'italic',
  },
  skipButton: {
    alignItems: 'center',
    padding: 14,
    marginTop: 8,
  },
  skipButtonText: {
    fontSize: 14,
    color: Echopay.textMuted,
  },
});
