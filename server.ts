import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import firebaseConfig from './firebase-applet-config.json' assert { type: 'json' };

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Initialize Firebase Admin
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      initializeApp({
        credential: cert(serviceAccount)
      });
      console.log('Firebase Admin initialized successfully');
      
      // Start Notification Dispatcher
      startNotificationDispatcher();
    } catch (error) {
      console.error('Failed to initialize Firebase Admin:', error);
    }
  } else {
    console.warn('FIREBASE_SERVICE_ACCOUNT not found. Push notifications will not be dispatched.');
  }

  // API routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Test Notification Endpoint
  app.post("/api/test-notification", express.json(), async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    try {
      const db = getFirestore(firebaseConfig.firestoreDatabaseId);
      const fcm = getMessaging();
      const userDoc = await db.collection('users').doc(userId).get();

      if (!userDoc.exists) {
        return res.status(404).json({ error: "User not found" });
      }

      let tokens: string[] = [];
      const userData = userDoc.data() || {};

      // Collect tokens for the sender (userId)
      let senderTokens: string[] = [];
      if (userData.devices) {
        senderTokens = Object.values(userData.devices as any).map((d: any) => d.token);
      }
      if (senderTokens.length === 0 && userData.fcmTokens) {
        senderTokens = userData.fcmTokens;
      }
      tokens.push(...senderTokens);

      // Collect tokens of ALL admin users (admins must always be alerted for tests and events)
      try {
        const adminsSnap = await db.collection('users').where('role', '==', 'admin').get();
        for (const adminDoc of adminsSnap.docs) {
          const adminData = adminDoc.data() || {};
          let adminTokens: string[] = [];
          if (adminData.devices) {
            adminTokens = Object.values(adminData.devices as any).map((d: any) => d.token);
          }
          if (adminTokens.length === 0 && adminData.fcmTokens) {
            adminTokens = adminData.fcmTokens;
          }
          tokens.push(...adminTokens);
        }
      } catch (err) {
        console.warn('[PUSH] Failed to fetch admin tokens:', err);
      }

      // Final unique list
      tokens = [...new Set(tokens)].filter(t => !!t);
      
      console.log(`[PUSH] Sending test notification to ${tokens.length} tokens for user ${userId}`);

      if (tokens.length === 0) {
        return res.status(400).json({ error: "Nenhum dispositivo encontrado para este usuário." });
      }

      const message: any = {
        notification: {
          title: "Agenda",
          body: "Teste de Notificação | Seu sistema push está online e configurado com sucesso! 🎉"
        },
        data: { 
          test: "true",
          tag: "test-notification",
          click_action: "/settings"
        },
        android: {
          priority: 'high',
          notification: {
            sound: 'default',
            priority: 'high',
            channelId: 'high_priority', // Custom channel often needed for Android
            clickAction: 'SETTINGS'
          }
        },
        webpush: {
          headers: {
            Urgency: 'high'
          },
          notification: {
            tag: "test-notification",
            requireInteraction: true,
            icon: '/icons/icon-192.png',
            badge: '/icons/icon-192.png'
          },
          fcmOptions: {
            link: '/settings'
          }
        },
        tokens
      };

      const response = await fcm.sendEachForMulticast(message);
      
      // Advanced Cleanup
      if (response.failureCount > 0) {
        const invalidTokens: string[] = [];
        response.responses.forEach((resp, idx) => {
          if (!resp.success) {
            const errCode = resp.error?.code;
            if (errCode === 'messaging/registration-token-not-registered' || errCode === 'messaging/invalid-registration-token') {
              invalidTokens.push(tokens[idx]);
            }
          }
        });

        if (invalidTokens.length > 0) {
          console.log(`[PUSH] Cleaning up ${invalidTokens.length} stale tokens for user ${userId}`);
          
          // Cleanup Map
          if (userData.devices) {
            const updatedDevices = { ...userData.devices };
            Object.keys(updatedDevices).forEach(key => {
              if (invalidTokens.includes(updatedDevices[key].token)) {
                delete updatedDevices[key];
              }
            });
            await db.collection('users').doc(userId).update({ devices: updatedDevices });
          }

          // Cleanup Array
          const remainingTokens = tokens.filter(t => !invalidTokens.includes(t));
          if (remainingTokens.length !== tokens.length) {
            await db.collection('users').doc(userId).update({ fcmTokens: remainingTokens });
          }
        }
      }

      res.json({ 
        success: response.successCount > 0, 
        successCount: response.successCount, 
        failureCount: response.failureCount 
      });
    } catch (error) {
      console.error("Test notification error:", error);
      res.status(500).json({ error: String(error) });
    }
  });

  // Vite middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

/**
 * Basic Notification Dispatcher
 * Checks for upcoming appointments and sends push notifications
 */
async function startNotificationDispatcher() {
  const db = getFirestore(firebaseConfig.firestoreDatabaseId);
  const fcm = getMessaging();

  console.log('--- [PUSH] Starting notification dispatcher loop ---');

  setInterval(async () => {
    try {
      const now = new Date();
      console.log(`[PUSH] Checking appointments at ${now.toISOString()}`);
      
      // Look for appointments in a wider range to be safe (next 26 hours)
      const maxFuture = new Date(now.getTime() + 26 * 60 * 60 * 1000);
      
      const appointmentsSnap = await db.collection('appointments')
        .where('startTime', '>=', now.toISOString())
        .where('startTime', '<=', maxFuture.toISOString())
        .get();

      const adminsSnap = await db.collection('users').where('role', '==', 'admin').get();
      const adminUsers = adminsSnap.docs.map(d => ({ uid: d.id, ...d.data() }));

      console.log(`[PUSH] Found ${appointmentsSnap.size} upcoming appointments and ${adminUsers.length} admins`);

      for (const appointmentDoc of appointmentsSnap.docs) {
        const appointment = appointmentDoc.data();
        const startTime = new Date(appointment.startTime);
        const diffMs = startTime.getTime() - now.getTime();
        const diffMin = Math.round(diffMs / 60000);

        const status = appointment.notificationStatus || {};
        
        // Notify Client, Professional, and all Admins
        const participantUids = [appointment.clientId, appointment.professionalId].filter(uid => !!uid);
        const adminUids = adminUsers.map(a => a.uid);
        const uidsToNotify = [...new Set([...participantUids, ...adminUids])];

        for (const uid of uidsToNotify) {
          // Check if user is in pre-fetched admin list
          let userData = adminUsers.find(a => a.uid === uid) as any;
          
          // If not in pre-fetched list, fetch dedicated doc
          if (!userData) {
            const userDoc = await db.collection('users').doc(uid).get();
            if (!userDoc.exists) continue;
            userData = { uid, ...userDoc.data() };
          }
          
          const settings = userData.notificationSettings || { enabled: true, remindersEnabled: true, reminderMinutes: 30 };
          if (!settings.enabled || !settings.remindersEnabled) continue;

          const userPrefix = `sent_${uid}_`;
          
          // 1. 24 Hours Alert
          if (diffMin <= 1440 && diffMin > 1200 && !status[`${userPrefix}24h`]) {
            await sendAppointmentPush(fcm, db, appointmentDoc.id, appointment, '24h', userData, userPrefix);
          }

          // 2. Custom User Reminder Alert
          const customMin = settings.reminderMinutes || 30;
          const userSentKey = `${userPrefix}${customMin}m`;
          
          // Window check: if we are within the user's reminder window 
          // allow a grace period of 5 mins past the start of the window
          if (diffMin <= customMin && diffMin > -2 && !status[userSentKey]) {
            await sendAppointmentPush(fcm, db, appointmentDoc.id, appointment, `${customMin}m`, userData, userPrefix);
          }
        }
      }
    } catch (error) {
      console.error('[PUSH] Error in notification dispatcher:', error);
    }
  }, 3 * 60 * 1000); // Check every 3 minutes for tighter windows
}

async function sendAppointmentPush(fcm: any, db: any, id: string, appointment: any, type: string, userData: any, userPrefix: string = '') {
  try {
    let tokens: string[] = [];
    
    if (userData.devices) {
      tokens = Object.values(userData.devices as any).map((d: any) => d.token);
    }
    
    if (tokens.length === 0 && userData.fcmTokens) {
      tokens = userData.fcmTokens;
    }

    tokens = [...new Set(tokens)].filter(t => !!t);
    
    if (tokens.length === 0) {
      console.log(`[PUSH] Skipping ${type} - No tokens for user ${userData.uid}`);
      return;
    }

    let title = 'Agenda';
    let body = '';
    
    const startTime = new Date(appointment.startTime);
    const timeZone = 'America/Sao_Paulo';
    
    // Formatting parts correctly for pt-BR and Brazil timezone
    const timeStr = startTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone });
    const dateStr = startTime.toISOString().split('T')[0]; // YYYY-MM-DD
    const weekday = startTime.toLocaleDateString('pt-BR', { weekday: 'long', timeZone });
    const day = startTime.toLocaleDateString('pt-BR', { day: '2-digit', timeZone });
    const month = startTime.toLocaleDateString('pt-BR', { month: '2-digit', timeZone });
    
    const label = type === '24h' ? 'Amanhã' : 'Hoje';
    const serviceName = appointment.serviceNames?.[0] || 'Atendimento';
    
    // Format: Hoje | quarta-feira, 14/05 - 09:45 - Limpeza de Pele
    body = `${label} | ${weekday}, ${day}/${month} - ${timeStr} - ${serviceName}`;

    console.log(`[PUSH] Dispatching to ${userData.displayName || userData.uid} (${tokens.length} tokens): ${body} | Action: /calendar?appointmentId=${id}&date=${dateStr}`);

    const message: any = {
      notification: { title, body },
      data: { 
        appointmentId: id, 
        date: dateStr,
        time: timeStr,
        professional: appointment.professionalName || '',
        click_action: `/calendar?appointmentId=${id}&date=${dateStr}`,
        tag: `appointment-${id}`
      },
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          priority: 'high',
          channelId: 'high_priority'
        }
      },
      webpush: {
        headers: { Urgency: 'high' },
        notification: {
          tag: `appointment-${id}`,
          requireInteraction: true,
          icon: '/icons/icon-192.png',
          badge: '/icons/icon-192.png'
        },
        fcmOptions: {
          link: `/calendar?appointmentId=${id}&date=${dateStr}`
        }
      },
      tokens
    };

    const response = await fcm.sendEachForMulticast(message);
    
    if (response.failureCount > 0) {
      const staleTokens: string[] = [];
      response.responses.forEach((resp: any, idx: number) => {
        if (!resp.success) {
          const code = resp.error?.code;
          if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
            staleTokens.push(tokens[idx]);
          }
        }
      });

      if (staleTokens.length > 0) {
        if (userData.devices) {
          const updatedDevices = { ...userData.devices };
          Object.keys(updatedDevices).forEach(key => {
            if (staleTokens.includes(updatedDevices[key].token)) delete updatedDevices[key];
          });
          await db.collection('users').doc(userData.uid).update({ devices: updatedDevices });
        }
        const remaining = tokens.filter(t => !staleTokens.includes(t));
        await db.collection('users').doc(userData.uid).update({ fcmTokens: remaining });
      }
    }

    // Mark as sent for this user
    await db.collection('appointments').doc(id).update({ 
      [`notificationStatus.${userPrefix}${type}`]: true,
      [`notificationStatus.sent${type}`]: true 
    });

  } catch (error) {
    console.error(`[PUSH] Dispatch failed for ${id}:`, error);
  }
}

startServer();
