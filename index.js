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
    const parcelsCollection = myDB.collection("parcels");
    const paymentCollection = myDB.collection("payments");
    const trackingCollection = myDB.collection("tracking");
    const usersCollection = myDB.collection("user");
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
        res.status(403).send({ message: "Forbidden Access" });
      }
    };

    // verfiy Admin
    const verfiyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const user = await usersCollection.findOne({ email });
      if (!user || user?.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    app.post("/parcels", async (req, res) => {
      try {
        const parcelData = req.body;

        const result = await parcelsCollection.insertOne(parcelData);

        res.status(201).send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // get data from parcelsCollection by email, payment status and delivery status
    app.get("/parcels", verifyFirebaseToken, async (req, res) => {
      const { email, paymentStatus, deliveryStatus } = req.query;

      const query = {};

      if (email) {
        query.created_by = email;
      }

      if (paymentStatus) {
        query.paymentStatus = paymentStatus;
      }

      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      }

      const parcels = await parcelsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

      res.send(parcels);
    });

    // get data for specific id
    app.get("/parcels/:parcelId", async (req, res) => {
      try {
        const parcelId = req.params.parcelId;

        if (!ObjectId.isValid(parcelId)) {
          return res.status(400).send("Invalid ID");
        }

        const result = await parcelsCollection.findOne({
          _id: new ObjectId(parcelId),
        });

        res.send(result);
      } catch (err) {
        res.status(500).send(err.message);
      }
    });
    // Assign Rider API where parcelsCollection and rider collection are change their status
    app.patch(
      "/parcels/assign-rider/:parcelId",
      verifyFirebaseToken,
      verfiyAdmin,
      async (req, res) => {
        const parcelId = req.params.parcelId;
        const { riderId, riderEmail } = req.body;

        const session = client.startSession();

        try {
          await session.withTransaction(async () => {
            // update parcel
            await parcelsCollection.updateOne(
              { _id: new ObjectId(parcelId) },
              {
                $set: {
                  deliveryStatus: "rider_assign",
                  assignedRiderId: riderId,
                  assignedRiderEmail: riderEmail,
                  assignedAt: new Date().toISOString(),
                },
              },
              { session },
            );

            // update rider
            await ridersCollection.updateOne(
              { _id: new ObjectId(riderId) },
              {
                $set: {
                  work_status: "in-delivery",
                },
              },
              { session },
            );
          });

          res.send({ success: true });
        } catch (err) {
          res.status(500).send({ message: "Assign failed" });
        } finally {
          await session.endSession();
        }
      },
    );

    // status update when rider receive and delivery parcel
    app.patch(
      "/parcels/rider-status/:id",
      verifyFirebaseToken,
      async (req, res) => {
        const id = req.params.id;
        const { status } = req.body;

        const updateDoc = {
          $set: {
            deliveryStatus: status,
          },
        };

        // add timestamps based on status
        if (status === "in-transit") {
          updateDoc.$set.pickedAt = new Date().toISOString();
        }

        if (status === "completed") {
          updateDoc.$set.deliveredAt = new Date().toISOString();
        }

        const result = await parcelsCollection.updateOne(
          { _id: new ObjectId(id) },
          updateDoc,
        );

        res.send(result);
      },
    );

    // delete parcel
    app.delete("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };
        const result = await parcelsCollection.deleteOne(filter);

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
      await parcelsCollection.updateOne(
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

    // user data get only admin

    app.get("/users", verifyFirebaseToken, verfiyAdmin, async (req, res) => {
      const search = req.query.search || "";

      const query = search
        ? {
            $or: [
              { name: { $regex: search, $options: "i" } },
              { email: { $regex: search, $options: "i" } },
            ],
          }
        : {};

      const users = await usersCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

      res.send(users);
    });

    // user insert here
    app.post("/users", async (req, res) => {
      const { name, email, role, createdAt, lastLoginAt } = req.body;

      try {
        // 🔍 check if user exists
        const existingUser = await usersCollection.findOne({ email });

        if (existingUser) {
          // ✅ update last login time
          await usersCollection.updateOne(
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

        const result = await usersCollection.insertOne(newUser);

        res.send(result);
      } catch (error) {
        res.status(500).send({
          message: "User processing failed",
          error: error.message,
        });
      }
    });

    // change role by admin
    app.patch("/users/:id/role", async (req, res) => {
      const id = req.params.id;
      const { role } = req.body;

      if (!role) {
        return res.status(400).send({ message: "Role is required" });
      }

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { role } },
      );

      res.send(result);
    });

    // rider data for fetch
    app.get("/riders", verifyFirebaseToken, verfiyAdmin, async (req, res) => {
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

    // Get Active Riders by District
    app.get(
      "/riders/active-by-district",
      verifyFirebaseToken,
      verfiyAdmin,
      async (req, res) => {
        const { district } = req.query;

        if (!district) {
          return res.status(400).send({ message: "District required" });
        }

        const riders = await ridersCollection
          .find({
            status: "active",
            district: district,
          })
          .toArray();

        res.send(riders);
      },
    );
    // rider pending deliveries for pending delivery

    app.get(
      "/rider/pending-deliveries",
      verifyFirebaseToken,
      async (req, res) => {
        const email = req.decoded.email;

        const parcels = await parcelsCollection
          .find({
            assignedRiderEmail: email,
            deliveryStatus: { $in: ["in-transit", "rider_assign"] },
          })
          .toArray();

        res.send(parcels);
      },
    );

    // GET user role for cusmtom hook so that can understand that is it admin or user or rider
    app.get("/users/role/:email", async (req, res) => {
      try {
        const email = req.params.email;

        const user = await usersCollection.findOne(
          { email },
          { projection: { role: 1 } },
        );

        if (!user) {
          return res.status(404).send({ role: "user" });
        }

        res.send({ role: user.role });
      } catch (error) {
        res.status(500).send({ message: "Failed to get role" });
      }
    });

    // PATCH /riders/:id/status

    app.patch("/riders/:id/status", async (req, res) => {
      const id = req.params.id;
      const { status } = req.body;

      try {
        // update rider status
        const riderResult = await ridersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status } },
        );

        // if approved → update user role
        if (status === "active") {
          const rider = await ridersCollection.findOne({
            _id: new ObjectId(id),
          });

          if (rider?.email) {
            await usersCollection.updateOne(
              { email: rider.email },
              { $set: { role: "rider" } },
            );
          }
        }

        // if rejected/deactivated → reset role back to user (optional)
        if (status === "rejected" || status === "deactivated") {
          const rider = await ridersCollection.findOne({
            _id: new ObjectId(id),
          });

          if (rider?.email) {
            await usersCollection.updateOne(
              { email: rider.email },
              { $set: { role: "user" } },
            );
          }
        }

        res.send({
          modifiedCount: riderResult.modifiedCount,
        });
      } catch (err) {
        res.status(500).send({ message: "Status update failed" });
      }
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
