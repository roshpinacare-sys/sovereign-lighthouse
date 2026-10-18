import crypto from 'crypto';
import https from 'https';
import fs from 'fs';
import { URL } from 'url';

class InterRepoAuth {
  constructor(serviceName, config) {
    this.serviceName = serviceName;
    this.config = config;
    this.jwtSecret = crypto.randomBytes(32).toString('hex');
    this.sessionStore = new Map();
    this.init();
  }

  init() {
    // Generate key pair if not exists
    if (!fs.existsSync(`${this.serviceName}_private.pem`)) {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: {
          type: 'spki',
          format: 'pem'
        },
        privateKeyEncoding: {
          type: 'pkcs8',
          format: 'pem'
        }
      });
      
      fs.writeFileSync(`${this.serviceName}_public.pem`, publicKey);
      fs.writeFileSync(`${this.serviceName}_private.pem`, privateKey);
    }
    
    this.publicKey = fs.readFileSync(`${this.serviceName}_public.pem`, 'utf8');
    this.privateKey = fs.readFileSync(`${this.serviceName}_private.pem`, 'utf8');
  }

  // Step 1: Exchange public keys via TLS 1.3
  async exchangePublicKeys() {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.config.remoteHost,
        port: this.config.remotePort,
        path: '/exchange-keys',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Name': this.serviceName
        }
      };
      
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            if (res.statusCode === 200) {
              this.remotePublicKey = response.publicKey;
              resolve(response);
            } else {
              reject(new Error(`Key exchange failed: ${response.error}`));
            }
          } catch (e) {
            reject(new Error('Invalid response format'));
          }
        });
      });
      
      req.on('error', reject);
      req.write(JSON.stringify({ publicKey: this.publicKey }));
      req.end();
    });
  }

  // Step 2: Generate JWT with short expiration
  generateJWT(payload) {
    const header = {
      alg: 'RS256',
      typ: 'JWT'
    };
    
    const now = Math.floor(Date.now() / 1000);
    const tokenPayload = {
      ...payload,
      iat: now,
      exp: now + 300, // 5 minutes max
      iss: this.serviceName,
      jti: crypto.randomUUID()
    };
    
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(tokenPayload)).toString('base64url');
    
    const signature = crypto.sign(
      'sha256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      this.privateKey
    );
    
    const encodedSignature = signature.toString('base64url');
    
    return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
  }

  // Step 2: Verify JWT
  verifyJWT(token) {
    try {
      const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
      
      // Verify signature
      const isValid = crypto.verify(
        'sha256',
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        this.remotePublicKey,
        Buffer.from(encodedSignature, 'base64url')
      );
      
      if (!isValid) {
        throw new Error('Invalid signature');
      }
      
      const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString());
      
      // Check expiration
      if (payload.exp < Math.floor(Date.now() / 1000)) {
        throw new Error('Token expired');
      }
      
      // Check issuer
      if (payload.iss !== this.config.remoteServiceName) {
        throw new Error('Invalid issuer');
      }
      
      return payload;
    } catch (e) {
      throw new Error(`JWT verification failed: ${e.message}`);
    }
  }

  // Step 3: Log encrypted events
  logEvent(event) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      service: this.serviceName,
      event,
      nonce: crypto.randomBytes(16).toString('hex')
    };
    
    // Encrypt log entry
    const cipher = crypto.createCipher('aes-256-cbc', this.jwtSecret);
    let encrypted = cipher.update(JSON.stringify(logEntry), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    // Store encrypted log
    const logId = crypto.randomUUID();
    this.sessionStore.set(logId, encrypted);
    
    // In a real implementation, this would be written to a secure log system
    return logId;
  }

  // Step 4: Challenge-response mechanism
  generateChallenge() {
    const challenge = crypto.randomBytes(32).toString('hex');
    this.sessionStore.set(`challenge_${challenge}`, true);
    return challenge;
  }

  verifyChallenge(challenge) {
    const isValid = this.sessionStore.has(`challenge_${challenge}`);
    this.sessionStore.delete(`challenge_${challenge}`);
    return isValid;
  }

  // Secure API request with authentication
  async makeSecureRequest(endpoint, method, data) {
    // Generate challenge
    const challenge = this.generateChallenge();
    
    // Create request payload with challenge
    const payload = {
      challenge,
      data,
      timestamp: Date.now()
    };
    
    // Generate JWT
    const token = this.generateJWT(payload);
    
    // Make authenticated request
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.config.remoteHost,
        port: this.config.remotePort,
        path: endpoint,
        method: method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-Service-Name': this.serviceName
        }
      };
      
      const req = https.request(options, (res) => {
        let responseData = '';
        res.on('data', chunk => responseData += chunk);
        res.on('end', () => {
          try {
            // Log the request
            this.logEvent({
              type: 'api_request',
              endpoint,
              method,
              status: res.statusCode
            });
            
            // Verify response challenge
            const response = JSON.parse(responseData);
            if (!this.verifyChallenge(response.responseChallenge)) {
              throw new Error('Invalid response challenge');
            }
            
            resolve(response);
          } catch (e) {
            reject(e);
          }
        });
      });
      
      req.on('error', reject);
      req.write(JSON.stringify(data));
      req.end();
    });
  }
}

// Configuration for sovereign-lighthouse
const lighthouseConfig = {
  remoteHost: 'console.example.com',
  remotePort: 443,
  remoteServiceName: 'SovereignConsole',
  allowedEndpoints: ['/sync', '/status', '/config']
};

// Configuration for SovereignConsole
const consoleConfig = {
  remoteHost: 'lighthouse.example.com',
  remotePort: 443,
  remoteServiceName: 'sovereign-lighthouse',
  allowedEndpoints: ['/update', '/query', '/acknowledge']
};

// Initialize authentication for both services
const lighthouseAuth = new InterRepoAuth('sovereign-lighthouse', lighthouseConfig);
const consoleAuth = new InterRepoAuth('SovereignConsole', consoleConfig);

// Example usage for sovereign-lighthouse
async function lighthouseExample() {
  try {
    // Step 1: Exchange keys
    await lighthouseAuth.exchangePublicKeys();
    console.log('Key exchange successful');
    
    // Step 2-4: Make authenticated request
    const response = await lighthouseAuth.makeSecureRequest(
      '/sync',
      'POST',
      { state: 'active', timestamp: Date.now() }
    );
    
    console.log('Secure request successful:', response);
  } catch (error) {
    console.error('Authentication failed:', error.message);
  }
}

// Example usage for SovereignConsole
async function consoleExample() {
  try {
    // Step 1: Exchange keys
    await consoleAuth.exchangePublicKeys();
    console.log('Key exchange successful');
    
    // Step 2-4: Make authenticated request
    const response = await consoleAuth.makeSecureRequest(
      '/update',
      'PUT',
      { config: { version: '1.2.3' }, timestamp: Date.now() }
    );
    
    console.log('Secure request successful:', response);
  } catch (error) {
    console.error('Authentication failed:', error.message);
  }
}

// Run examples
lighthouseExample();
consoleExample();
