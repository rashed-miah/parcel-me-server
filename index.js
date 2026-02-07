const express = require("express");
const cors = require("cors");
require("dotenv").config();
const PORT = process.env.PORT || 5000;
const app = express();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
//name: parcel-me
// password: WnE3LWtqgYVRF0lg
// middlewares
app.use(cors());
app.use(express.json());
const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
// for firebase jwt token
const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

// mongodb database

const uri = `mongodb+srv://${process.env.USER_NAME}:${process.env.PASSWORD}@cluster0.qhxuye0.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

async function run() {
  try {
    const myDB = client.db("parcel-me");
    // all collection
    const parcelCollection = myDB.collection("parcels");
    const paymentCollection = myDB.collection("payments");
    const trackingCollection = myDB.collection("tracking");
    const userCollection = myDB.collection("user");
    const ridersCollection = myDB.collection("riders");

    // jwt token verify

    const verifyFirebaseToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      console.log("auth", authHeader);

      if (!authHeader?.startsWith("Bearer ")) {
        return res.status(401).send({ message: "Unauthorized" });
      }

      const token = authHeader.split(" ")[1];

      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        res.status(403).send({ message: "Forbidden" });
      }
    };

    app.post("/parcels", async (req, res) => {
      try {
        const parcelData = req.body;

        const result = await parcelCollection.insertOne(parcelData);

        res.status(201).send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // get data from parcelCollection
    app.get("/parcels", verifyFirebaseToken, async (req, res) => {
      const email = req.query.email;
      const query = email ? { created_by: email } : {};
      const myParcelData = await parcelCollection.find(query).toArray();
      res.send(myParcelData);
    });

    // get data for specific id
    app.get("/parcels/:parcelId", async (req, res) => {
      try {
        const parcelId = req.params.parcelId;

        if (!ObjectId.isValid(parcelId)) {
          return res.status(400).send("Invalid ID");
        }

        const result = await parcelCollection.findOne({
          _id: new ObjectId(parcelId),
        });

        res.send(result);
      } catch (err) {
        res.status(500).send(err.message);
      }
    });

    // delete parcel
    app.delete("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };
        const result = await parcelCollection.deleteOne(filter);

        res.status(200).send(result);
      } catch (error) {
        res.status(500).send({
          message: "Failed to delete parcel",
          error: error.message,
        });
      }
    });

    // Create Payment Intent API

    app.post("/create-payment-intent", async (req, res) => {
      try {
        const { amountInCent } = req.body;
        console.log("amount", amountInCent);

        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCent,
          currency: "USD",
          payment_method_types: ["card"],
        });

        res.send({
          clientSecret: paymentIntent.client_secret,
        });
      } catch (err) {
        res.status(500).send({ error: err.message });
      }
    });

    // payment data
    app.post("/payments", async (req, res) => {
      const paymentData = req.body;
      const paymentdoc = {
        ...paymentData,
        paid_at_string: new Date().toISOString(),
        paid_at: new Date(),
      };

      // update parcel payment status
      await parcelCollection.updateOne(
        { _id: new ObjectId(paymentData.parcelId) },
        {
          $set: {
            paymentStatus: "paid",
          },
        },
      );
      // save payment history
      const paymentResult = await paymentCollection.insertOne(paymentdoc);

      res.send({ success: true, paymentResult });
    });

    // POST – add tracking update
    app.post("/tracking", async (req, res) => {
      try {
        const tracking = {
          ...req.body,
          createdAt: new Date(),
        };
        const result = await trackingCollection.insertOne(tracking);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to add tracking update" });
      }
    });

    app.get("/tracking/:trackingId", verifyFirebaseToken, async (req, res) => {
      const { trackingId } = req.params;

      const result = await trackingCollection
        .find({ trackingId })
        .sort({ createdAt: 1 })
        .toArray();

      if (!result.length) {
        return res.status(404).send({ message: "Tracking not found" });
      }

      res.send(result);
    });

    // get payment history
    app.get("/payments", verifyFirebaseToken, async (req, res) => {
      const userEmail = req.query.email;
      if (req.decoded.email !== userEmail) {
        return res.status(403).send({ message: "forbiden Access" });
      }

      try {
        const query = userEmail ? { email: userEmail } : {};
        const history = await paymentCollection
          .find(query)
          .sort({ paid_at: -1 }) // Latest first
          .toArray();

        res.send(history);
      } catch (error) {
        console.error("Error fetching payment history:", error);
        res.status(500).send({ message: "Failed to load payment history" });
      }
    });

    // user insert here
    app.post("/users", async (req, res) => {
      const { name, email, role, createdAt, lastLoginAt } = req.body;

      try {
        // 🔍 check if user exists
        const existingUser = await userCollection.findOne({ email });

        if (existingUser) {
          // ✅ update last login time
          await userCollection.updateOne(
            { email },
            {
              $set: {
                lastLoginAt: new Date().toISOString(),
              },
            },
          );

          return res.send({
            isNewUser: false,
            user: existingUser,
          });
        }

        // 🆕 create new user
        const newUser = {
          name,
          email,
          role,
          createdAt,
          lastLoginAt,
        };

        const result = await userCollection.insertOne(newUser);

        res.send(result);
      } catch (error) {
        res.status(500).send({
          message: "User processing failed",
          error: error.message,
        });
      }
    });

    // rider data for fetch
    app.get("/riders", async (req, res) => {
      const { status, search } = req.query;

      const query = status ? { status } : {};
      if (search) {
        query.name = { $regex: search, $options: "i" };
      }

      const riders = await ridersCollection
        .find(query)
        .sort({ created_at: -1 })
        .toArray();

      res.send(riders);
    });

    // PATCH /riders/:id/status

    app.patch("/riders/:id/status", async (req, res) => {
      const id = req.params.id;
      const { status } = req.body;

      const result = await ridersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status } },
      );

      res.send(result);
    });

    // rider data for storage
    app.post("/riders", async (req, res) => {
      try {
        const rider = req.body;

        // prevent duplicate application by email
        // const existing = await ridersCollection.findOne({
        //   email: rider.email,
        // });

        // if (existing) {
        //   return res.status(409).send({
        //     message: "You already applied",
        //   });
        // }

        const result = await ridersCollection.insertOne(rider);

        res.send({
          success: true,
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("Rider insert error:", error);
        res.status(500).send({
          message: "Failed to save rider",
        });
      }
    });

    // test route
    app.get("/", (req, res) => {
      res.send("Parcel Delivery Backend Running");
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
  }
}
run().catch(console.dir);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
