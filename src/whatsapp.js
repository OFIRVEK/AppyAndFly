import axios from "axios";
import { config } from "./config.js";

export async function sendWhatsApp(message, to = config.whatsapp.to) {
  try {
    const url = `https://graph.facebook.com/v20.0/${config.whatsapp.phoneNumberId}/messages`;

    console.log(
      `[whatsapp] sending -> phoneNumberId=${config.whatsapp.phoneNumberId} to=${to} tokenSet=${!!config.whatsapp.token}`
    );

    const res = await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${config.whatsapp.token}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("[whatsapp] send success:", JSON.stringify(res.data));
  } catch (err) {
    console.error("WhatsApp send error:", err.response?.data || err.message || err);
  }
}