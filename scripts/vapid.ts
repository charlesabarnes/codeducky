// Generates a VAPID key pair for Web Push and prints it as the server's environment. Run: npm run vapid
import { generateVapidKeys } from '../server/push/webPush'

const { publicKey, privateKey } = await generateVapidKeys()

console.log(`CODEDUCKY_VAPID_PUBLIC_KEY=${publicKey}
CODEDUCKY_VAPID_PRIVATE_KEY=${privateKey}
CODEDUCKY_VAPID_SUBJECT=mailto:you@example.com`)
console.error(
  '\nSet these as secrets, with your own mailto: address or https: URL as the subject. Keep the private key secret.\n' +
    'Changing the pair later ends every subscription; each device subscribes again the next time Code Ducky opens there.',
)
