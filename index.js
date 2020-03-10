const admin = require('firebase-admin');
const fetch = require('node-fetch');
const { includes, isEmpty, lowerCase, random } = require('lodash');
const serviceAccount = require('./secret/serviceAccountKey.json'); // это должен быть ваш собственный ключ

// Инициализируем Firestore:
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://your-project-name.firebaseio.com" // вместо your-project-name должно быть указано актуальное имя
});

// Подключение к БД:
const db = admin.firestore();
const server = admin.firestore;
let usersRef;

// Вебхук Битрикс24. ДЕРЖИТЕ В ТАЙНЕ!
// Получаем в консоли Битрикс24 (вид URL будет как показан здесь, только вместо your-name и xxxxxxx -- актуальные значения): 
// (Ещё) --> Приложения --> Вебхуки (вкладка) --> Добавить вебхук (кнопка) --> Входящий вебхук (выпадающий список). 
// Затем поставить чекбокс напротив CRM (crm).
// Последнюю часть URL сгенерированного вебхука /profile/ удалить, и заменить на: /crm.lead.add.json (как показано здесь):
const bitrix24Webhook = 'https://your-name.bitrix24.ru/rest/1/xxxxxxxxxxxx/crm.lead.add.json';


// Тело Yndex Cloude Function:
module.exports.bot = async (event) => {
  try {
    // Обрабатываем запрос от Telegram:
    const body = JSON.parse(event.body); // всё тело запроса от Telegram
    const uid = 'u' + body.message.from.id; // уникальный ID юзера в Telegram (с префиксом 'u')
    const firstName = body.message.from.first_name; // имя юзера
    const chatId = body.message.chat.id; // ID чата; необходим для ответа нашего бота в Telegram
    let msgTimestamp = body.message.date; // штамп времени сообщения от юзера
    const userMsg = lowerCase(body.message.text); // текст сообщения от юзера
    let phone = body.message.contact && body.message.contact.phone_number; // нормер телефона юзера (храним в БД)
    const coords = body.message.location; // географические координаты юзера

    let dbTimestamp = 0; // штамп времени из БД когда юзер последний раз вызывал такси
    let isTimeout = false; // флаг таймаута на новые вызовы такси -- защита от флуда
    let isTaxi = false; // флаг вызова такси
    let isOrderComplete = false;  // флаг оформления заказа
    let botMsg; // текст сообщения нашего бота

    // Обращаемся к БД за данными юзера:
    if (!usersRef) {
      usersRef = db.collection('users');
    }

    const userSnapshot = await usersRef.where(server.FieldPath.documentId(), '==', uid).get();
    let userData = {};

    userSnapshot.forEach(doc => {
      userData = doc.data();
    });

    if (!isEmpty(userData)) {
      phone = userData.phone;
      dbTimestamp = userData.ts;
    }

    // Анализируем текст юзера, и на этом основании формируем ему ответ и дальнейшие действия бота.
    // 1) Юзер прислал не текст, не телефон и не координаты, а нечто иное, например, картинку или стикер:
    if (!userMsg && !phone && !coords) {
      botMsg = `${firstName}, это замечательно! Но я всего лишь бот и понимаю только команды. Просто нажимайте кнопку вазова такси, когда это требуется. <i>Внимание! Такси не приедет - я демонстрационный бот!!!</i>`;

      // 2) Обработка стандартных для Telegram команд /start и /help:
    } else if (includes(userMsg, 'start')) {
      botMsg = 'Когда потребуется - нажмите кнопку вызова такси. <i>Внимание! Такси не приедет - я демонстрационный бот!!!</i>';
    } else if (includes(userMsg, 'help')) {
      botMsg = 'Нажмите кнопку вызова такси, когда оно вам потребуется. Я буду спрашивать ваш номер телефона и ваше местоположение. <i>Внимание! Такси не приедет - я демонстрационный бот!!!</i>';
    }

    // 3) Текст от юзера содержит слово "такси" или "машина(у)", поэтому предполагаем, что юзер хочет сделать заказ:
    else if (includes(userMsg, 'такси') || includes(userMsg, 'машин')) {
      isTaxi = true;
      // Не позволяем юзеру сильно флудить, т.е. отправлять заказ чаще чем 1 раз в 2 минуты (120 с):
      if (phone && !coords && (msgTimestamp - dbTimestamp) < 120) {
        isTimeout = true;
        botMsg = `${firstName}, мы обрабатываем ваш заказ. Пожалуйста, подождите немного.`;
      } else {
        if (!phone) {
          botMsg = 'Я готов принять ваш заказ! Теперь нажмите кнопку ниже, чтобы сообщить мне номер вашего телефона. По этому номеру диспетчер (человек, не робот) перезвонит в течение 2-х минут для уточнения деталей. <i>(На самом деле никто звонить не будет, поскольку это демонстрационный бот).</i>';
        } else {
          botMsg = 'Хорошо! Теперь нажмите кнопку ниже, чтобы сообщить ваше местоположение - мне необходимо знать куда присылать машину. Но диспетчер всё равно уточнит нюансы, позвонив вам в течение 2-х минут. <i>(На самом деле машина не приедет и звонить никто не будет, поскольку это демонстрационный бот).</i>';
        }
      }
    } else if (phone && !coords) {
      isTaxi = true;
      botMsg = 'Хорошо! Теперь нажмите на кнопку ниже, чтобы сообщить ваше местоположение - мне необходимо знать куда присылать машину. Но диспетчер всё равно уточнит нюансы, позвонив вам в течение 2-х минут. <i>(На самом деле машина не приедет и звонить никто не будет, потому что это лишь демонстрация моих возможностей).</i>';

      // 4) Все данные юзера собраны, можно отправлять заказ на исполнение (здесь в CRM Битрикс24):
    } else if (phone && coords) {
      // Формируем заказ:
      const order = {
        fields: {
          TITLE: 'Заказ Telegram.Такси #' + random(100, 1000),
          NAME: firstName,
          PHONE: [{ VALUE: phone, VALUE_TYPE: 'MOBILE' }],
          ADDRESS: `Широта: ${coords.latitude}. Долгота: ${coords.longitude} `,
          OPPORTUNITY: 100.00,
          CURRENCY_ID: 'RUB',
          STATUS_ID: 'NEW',
          PRODUCT_ID: 'OTHER'
        },
        params: { 'REGISTER_SONET_EVENT': 'Y' }
      };
      // Отправляем заказ в Битрикс24:
      fetch(bitrix24Webhook, {
        method: 'post',
        body: JSON.stringify(order),
        headers: { 'Content-Type': 'application/json' }
      })
        .then(res => res.json())
        .then(
          // Сообщение об успешном оформлении:
          isOrderComplete = true,
          botMsg = `<b>${firstName}, ваш заказ успешно оформлен!</b> Теперь пожалуйста подождите - через пару минут вам перезвонит диспетчер. <i>(На самом деле никто звонить не будет, поскольку это демонстрационный бот).</i>`
        )
        // Обработка возможных ошибок:
        .catch(err => {
          botMsg = 'Возникла неизвестная ошибка, и поэтому не удалось оформить заказ. Попробуйте ещё раз через несколько минут.';
          console.error('Fail sending an order to Bitrix24: ' + err);
        });

      // 5) Все иные, необрабатываемые нашим ботом фразы:
    } else {
      botMsg = `${firstName}, давайте не будем отвлекаться! Просто нажимайте кнопку вазова такси, когда это требуется. <i>Но, внимание! Такси не приедет - я демонстрационный бот!!!</i>`;
    }


    // Ответ нашего бота в Telegram (сообщение с дополнительными параметрами):
    let message = {};

    message = {
      'method': 'sendMessage',
      'parse_mode': 'HTML',
      'chat_id': chatId,
      'text': botMsg
    };

    // Различные кнопки в зависимости от условий:
    if (isTaxi) {
      if (!phone) {
        message.reply_markup = JSON.stringify({
          resize_keyboard: true,
          keyboard: [
            [{ text: 'Сообщить номер телефона', request_contact: true }]
          ]
        });
      } else {
        if (isTimeout) {
          message.reply_markup = JSON.stringify({
            resize_keyboard: true,
            keyboard: [
              [{ text: 'Вызвать такси' }]
            ]
          });
        } else {
          message.reply_markup = JSON.stringify({
            resize_keyboard: true,
            keyboard: [
              [{ text: 'Сообщить местоположение', request_location: true }]
            ]
          });
        }
      }
    } else {
      message.reply_markup = JSON.stringify({
        resize_keyboard: true,
        keyboard: [
          [{ text: 'Вызвать такси' }]
        ]
      });
    }

    // Запись в БД нового состояния приложения после ответа в Telegram (т.е. после return):
    if (phone) {
      // Не меняем штамп времени, если заказ не оформлен (для целей анти-флуда):
      if (!isOrderComplete) msgTimestamp = dbTimestamp;

      setImmediate((userId, phoneNumber, timestamp) => {
        usersRef.doc(userId).set({
          phone: phoneNumber,
          ts: timestamp,
        });
      }, uid, phone, msgTimestamp);
    }

    // Возвращаем сообщение в Telegram:
    return {
      'statusCode': 200,
      'headers': {
        'Content-Type': 'application/json'
      },
      'body': JSON.stringify(message),
      'isBase64Encoded': false
    };

    // Обработка возможных ошибок:
  } catch (err) {
    console.error(err);
    return {
      'statusCode': 500,
      'headers': {
        'Content-Type': 'text/plain'
      },
      'isBase64Encoded': false,
      'body': `Internal server error ${err}` // TODO удалить ${err} в продакшн-версии.
    };
  }
};
