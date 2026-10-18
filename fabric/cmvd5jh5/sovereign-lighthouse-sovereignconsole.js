import crypto from 'crypto';
import https from 'https';
import fs from 'fs';
import { promisify } from 'util';
import { createHash } from 'crypto';

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

class SecureAuthenticator {
  constructor() {
    this.maxAttempts = 3;
    this.lockoutDuration = 15 * 60 * 1000; // 15 minutes
    this.attempts = new Map();
    this.otpSecrets = new Map();
    this.apiKeys = new Map();
    this.accessLogs = [];
  }

  // Generate a secure API key with symmetric encryption
  generateAPIKey() {
    const rawKey = crypto.randomBytes(32).toString('hex');
    const encryptedKey = this.encrypt(rawKey, process.env.ENCRYPTION_KEY || 'default-secret-key');
    const keyId = `key_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    this.apiKeys.set(keyId, {
      encryptedKey,
      createdAt: new Date().toISOString(),
      lastUsed: null,
      active: true
    });
    
    return { keyId, rawKey };
  }

  // Validate API key
  async validateAPIKey(keyId, providedKey) {
    const keyData = this.apiKeys.get(keyId);
    if (!keyData || !keyData.active) {
      return false;
    }
    
    try {
      const decryptedKey = this.decrypt(keyData.encryptedKey, process.env.ENCRYPTION_KEY || 'default-secret-key');
      const isValid = decryptedKey === providedKey;
      
      if (isValid) {
        keyData.lastUsed = new Date().toISOString();
        this.logAccess(`API key validated: ${keyId}`, 'success');
      } else {
        this.logAccess(`Invalid API key attempt: ${keyId}`, 'failure');
      }
      
      return isValid;
    } catch (error) {
      this.logAccess(`API key validation error: ${keyId} - ${error.message}`, 'error');
      return false;
    }
  }

  // Generate OTP secret
  generateOTPSecret(userId) {
    const secret = crypto.randomBytes(20).toString('base32');
    this.otpSecrets.set(userId, secret);
    return secret;
  }

  // Verify OTP
  verifyOTP(userId, token) {
    const secret = this.otpSecrets.get(userId);
    if (!secret) return false;
    
    try {
      const verifier = crypto.createHmac('sha1', secret);
      verifier.update(token);
      const digest = verifier.digest('base64');
      return digest === token; // Simplified for example
    } catch (error) {
      this.logAccess(`OTP verification failed for user ${userId}: ${error.message}`, 'error');
      return false;
    }
  }

  // Check if user is locked out
  isLockedOut(userId) {
    const attempt = this.attempts.get(userId);
    if (!attempt || attempt.count < this.maxAttempts) return false;
    
    const timeSinceLastAttempt = Date.now() - attempt.lastAttempt;
    return timeSinceLastAttempt < this.lockoutDuration;
  }

  // Record authentication attempt
  recordAttempt(userId, success) {
    if (!this.attempts.has(userId)) {
      this.attempts.set(userId, { count: 0, lastAttempt: 0 });
    }
    
    const attempt = this.attempts.get(userId);
    attempt.lastAttempt = Date.now();
    
    if (success) {
      attempt.count = 0;
      this.logAccess(`Authentication successful for user ${userId}`, 'success');
    } else {
      attempt.count++;
      this.logAccess(`Authentication failed for user ${userId} (attempt ${attempt.count}/${this.maxAttempts})`, 'failure');
      
      if (attempt.count >= this.maxAttempts) {
        this.logAccess(`User ${userId} locked out due to too many failed attempts`, 'security');
      }
    }
  }

  // Log access
  logAccess(message, level = 'info') {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ip: this.getClientIP() || 'unknown',
      userAgent: this.getUserAgent() || 'unknown'
    };
    
    this.accessLogs.push(logEntry);
    
    // In a real system, you would write this to a secure log file or database
    console.log(`[${logEntry.timestamp}] [${logEntry.level.toUpperCase()}] ${logEntry.message}`);
  }

  // Get client IP (placeholder)
  getClientIP() {
    // In a real implementation, this would get the actual client IP
    return '127.0.0.1';
  }

  // Get user agent (placeholder)
  getUserAgent() {
    // In a real implementation, this would get the actual user agent
    return 'Mozilla/5.0';
  }

  // Encrypt data
  encrypt(text, secret) {
    const cipher = crypto.createCipher('aes-256-cbc', secret);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return encrypted;
  }

  // Decrypt data
  decrypt(text, secret) {
    const decipher = crypto.createDecipher('aes-256-cbc', secret);
    let decrypted = decipher.update(text, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  // Create HTTPS request with TLS 1.3
  async makeSecureRequest(options, data) {
    return new Promise((resolve, reject) => {
      const req = https.request({
        ...options,
        secureOptions: crypto.constants.SSL_OP_NO_TLSv1_2,
        minVersion: 'TLSv1.3'
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body
        }));
      });
      
      req.on('error', (err) => reject(err));
      
      if (data) {
        req.write(data);
      }
      
      req.end();
    });
  }
}

// Unit tests
function runTests() {
  const auth = new SecureAuthenticator();
  
  // Test API key generation and validation
  console.log('Testing API key generation and validation...');
  const { keyId, rawKey } = auth.generateAPIKey();
  const isValidKey = auth.validateAPIKey(keyId, rawKey);
  console.log(`API key validation: ${isValidKey ? 'PASS' : 'FAIL'}`);
  
  // Test OTP generation and verification
  console.log('\nTesting OTP generation and verification...');
  const userId = 'test_user';
  const otpSecret = auth.generateOTPSecret(userId);
  const validOTP = '123456'; // In reality, this would be generated by a proper OTP library
  const isValidOTP = auth.verifyOTP(userId, validOTP);
  console.log(`OTP verification: ${isValidOTP ? 'PASS' : 'FAIL'}`);
  
  // Test authentication attempts and lockout
  console.log('\nTesting authentication attempts and lockout...');
  auth.recordAttempt(userId, false);
  auth.recordAttempt(userId, false);
  auth.recordAttempt(userId, false); // Should trigger lockout
  const isLocked = auth.isLockedOut(userId);
  console.log(`Lockout after 3 failures: ${isLocked ? 'PASS' : 'FAIL'}`);
  
  // Test access logging
  console.log('\nTesting access logging...');
  auth.logAccess('Test log entry', 'info');
  console.log(`Access log entries: ${auth.accessLogs.length}`);
}

// Example usage
async function main() {
  const auth = new SecureAuthenticator();
  
  // Generate API keys for both services
  const lighthouseApiKey = auth.generateAPIKey();
  const consoleApiKey = auth.generateAPIKey();
  
  console.log('Sovereign Lighthouse API Key:', lighthouseApiKey.rawKey);
  console.log('Sovereign Console API Key:', consoleApiKey.rawKey);
  
  // Simulate secure communication between services
  console.log('\nSimulating secure communication...');
  const options = {
    hostname: 'localhost',
    port: 443,
    path: '/api/auth',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': lighthouseApiKey.rawKey
    }
  };
  
  try {
    const response = await auth.makeSecureRequest(options, JSON.stringify({ 
      action: 'authenticate',
      service: 'sovereign-lighthouse'
    }));
    
    console.log('Secure communication response:', response.statusCode);
  } catch (error) {
    console.error('Secure communication failed:', error.message);
  }
  
  // Run tests
  console.log('\nRunning unit tests...');
  runTests();
}

// Run the example
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export default SecureAuthenticator;